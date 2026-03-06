import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: Lark.Domain | string = Lark.Domain.Feishu;
  private connected = false;

  // For verification (when using webhook mode)
  private verificationToken: string = '';
  private encryptKey: string = '';

  constructor(
    appId: string,
    appSecret: string,
    domain: string,
    verificationToken: string,
    encryptKey: string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    if (domain === 'lark') {
      this.domain = Lark.Domain.Lark;
    } else if (domain) {
      this.domain = domain;
    }
    this.verificationToken = verificationToken;
    this.encryptKey = encryptKey;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Create REST client for sending messages and getting bot info
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });

    console.log(`  App ID: ${this.appId}`);
    console.log(`  Domain: ${this.domain}`);
    console.log(`  App Secret: ${this.appSecret.substring(0, 4)}...`);

    // Create WebSocket client for receiving messages via long connection
    console.log(`  Creating WSClient with appId=${this.appId}`);
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.debug,
      autoReconnect: false,
    });

    console.log(`  WSClient created, starting connection...`);

    // Create event dispatcher to handle incoming messages
    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: this.encryptKey || undefined,
      verificationToken: this.verificationToken || undefined,
    });

    // Handle im.message.receive_v1 event
    // Use object format: register({ 'event_type': handler })
    eventDispatcher.register({
      'im.message.receive_v1': (event: any) => {
        this.handleMessageEvent(event);
      },
    });

    // Start WebSocket connection - this connects to Feishu servers
    try {
      await this.wsClient.start({ eventDispatcher });
      logger.info('Feishu WebSocket long connection established');
      console.log(`\n  Feishu bot connected (App ID: ${this.appId})`);
      console.log(`  Status: Long connection established\n`);
    } catch (err) {
      logger.error({ err }, 'Failed to establish Feishu long connection');
      console.log(`  Feishu bot (App ID: ${this.appId})`);
      console.log(`  Status: Long connection failed - check credentials and app permissions\n`);
      return;
    }

    this.connected = true;
  }

  private handleMessageEvent(event: any): void {
    try {
      const message = event.message;
      if (!message) {
        return;
      }

      // Only process text messages for now
      if (message.message_type !== 'text') {
        logger.debug({ msgType: message.message_type }, 'Ignoring non-text message');
        return;
      }

      // Get chat info
      // JID format: feishu:oc_xxx (group) or feishu:ou_xxx (user)
      const chatId = message.chat_id;
      const chatJid = `feishu:${chatId}`;

      // Get sender info - from sender_id object
      const sender = message.sender?.sender_id?.open_id || message.sender?.sender_id?.user_id || '';

      // Parse message content
      let content = '';
      try {
        const contentObj = JSON.parse(message.content);
        content = contentObj.text || '';
      } catch {
        content = message.content;
      }

      // Feishu create_time - convert to proper date
      const createTime = parseInt(String(message.create_time), 10);
      const timestamp = new Date(createTime).toISOString();
      const msgId = message.message_id;

      // Check if this chat is registered - auto-register if not
      let group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        // Auto-register to feishu_main group
        const newGroup: RegisteredGroup = {
          name: 'Feishu Chat',
          folder: 'feishu_main',
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
        // Try to register the group
        if (this.opts.registerGroup) {
          this.opts.registerGroup(chatJid, newGroup);
          group = newGroup;
        }
      }

      // Store chat metadata
      const isGroup = chatId.startsWith('oc_');
      this.opts.onChatMetadata(chatJid, timestamp, chatId, 'feishu', isGroup);

      // Check if bot is mentioned in group chats
      let finalContent = content;
      if (isGroup && !TRIGGER_PATTERN.test(content)) {
        // For groups, require @mention - prepend trigger pattern
        finalContent = `@${ASSISTANT_NAME} ${content}`;
      }

      // Deliver message to the main handler
      const senderName = message.sender?.sender_id?.open_id || sender;
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: finalContent,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender }, 'Feishu message received');
    } catch (err) {
      logger.error({ err }, 'Error handling Feishu message event');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      // Extract chat_id from jid (format: feishu:chat_id or feishu:ou_xxx)
      const chatId = jid.replace(/^feishu:/, '');

      // Check if it's a user (ou_xxx) or group (oc_xxx)
      const receiveIdType = chatId.startsWith('ou_') ? 'open_id' : 'chat_id';

      // Feishu has a 20000 character limit per message - split if needed
      const MAX_LENGTH = 20000;
      const messages = this.splitMessage(text, MAX_LENGTH);

      for (const msg of messages) {
        await (this.client.im.message as any).create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: msg }),
          },
        });
      }

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const result: string[] = [];
    let current = '';

    for (const char of text) {
      if ((current + char).length > maxLength) {
        if (current) {
          result.push(current);
          current = '';
        }
      }
      current += char;
    }

    if (current) {
      result.push(current);
    }

    return result;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    this.client = null;
    this.connected = false;
    logger.info('Feishu bot stopped');
  }
}

// Register the channel
registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_ENCRYPT_KEY',
  ]);

  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  const domain = process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || 'feishu';
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN || envVars.FEISHU_VERIFICATION_TOKEN || '';
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY || envVars.FEISHU_ENCRYPT_KEY || '';

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, domain, verificationToken, encryptKey, opts);
});
