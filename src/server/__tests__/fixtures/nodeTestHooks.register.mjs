// Registration entry for nodeTestHooks.mjs (see that file for rationale).
import { register } from 'node:module'
register('./nodeTestHooks.mjs', import.meta.url)
