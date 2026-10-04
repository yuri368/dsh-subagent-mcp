import {resolve} from 'node:path';
import {projectRoot} from '../src/config.mjs';
import {packLocalRelease} from '../src/release-artifact.mjs';

const destination = resolve(process.argv[2] || 'work/local-release');
console.log(JSON.stringify(packLocalRelease(projectRoot, destination)));
