#!/usr/bin/env node
import { styleText } from 'node:util';
import { main } from '../dist/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(styleText('red', `pulse: ${err.message}`));
  process.exit(1);
});
