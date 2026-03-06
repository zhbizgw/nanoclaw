# Intent: add-feishu modify src/channels/index.ts

## What changed

Added the import for the Feishu channel:

```typescript
// feishu
import './feishu.js';
```

## Invariants

- The import must be placed in alphabetical order among other channel imports
- The comment `// feishu` must be included
- Must maintain the empty lines between other channels
