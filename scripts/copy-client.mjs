import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/client', { recursive: true });
cpSync('src/client', 'dist/client', { recursive: true });
