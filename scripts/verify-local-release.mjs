import {resolve} from 'node:path';
import {verifyReleaseArtifact} from '../src/release-artifact.mjs';
if (!process.argv[2]) throw new Error('Pass the downloaded release candidate .tgz path.');
console.log(JSON.stringify(verifyReleaseArtifact(resolve(process.argv[2]))));
