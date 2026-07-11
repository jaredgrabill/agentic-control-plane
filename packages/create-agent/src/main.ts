#!/usr/bin/env node
/** `create-agent <name>`: writes a runnable, eval-gated agent skeleton. */

import { scaffold } from './scaffold.js';

process.exitCode = scaffold(process.argv.slice(2));
