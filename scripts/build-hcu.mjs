import { execFileSync } from 'node:child_process';
import { mkdir, readFile, cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const revision = '697d3fbda04cb322915866bab1aad79c726a61e3';
const root = resolve('.data/vendor/hcu');
const output = resolve('.data/hcu');
const run = (program, args, cwd) => execFileSync(program, args, { cwd, stdio: 'inherit' });
await mkdir(output, { recursive: true });
await mkdir(root, { recursive: true });
run('git', ['init', '-q'], root);
run('git', ['fetch', '--depth', '1', 'https://github.com/microsoft/Hybrid-Computer-Use.git', revision], root);
run('git', ['checkout', '--detach', revision], root);
run('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'GOCACHE=/tmp/go-cache', '-e', 'GOMAXPROCS=2',
  '--mount', `type=bind,src=${root},dst=/source,readonly`, '--mount', `type=bind,src=${output},dst=/out`,
  '-w', '/source/computer-use', 'golang:1.24-bookworm', 'go', 'build', '-mod=vendor', '-trimpath',
  '-ldflags', '-s -w -X main.version=1.0.0', '-o', '/out/computer-use', './cmd/computer-use']);
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses']) await cp(resolve(root, name), resolve(output, name), { recursive: true });
const contract = JSON.parse(execFileSync(resolve(output, 'computer-use'), ['schema'], { encoding: 'utf8' }));
const tools = Object.fromEntries(contract.tools.map(tool => [tool.name, { description: tool.description, parameters: tool.input_schema }]));
await writeFile('src/desktop/hcu-contract.ts', `// Generated from Microsoft HCU ${revision} (MIT).\n// See deploy/desktop/HCU-LICENSE. Regenerate with scripts/build-hcu.mjs.\nimport type { ToolDefinition } from "@earendil-works/pi-coding-agent";\nexport const HCU_REVISION = "${revision}";\nexport const hcuDefinitions = ${JSON.stringify(tools, null, 2)} as unknown as Record<"AX" | "GUI", Pick<ToolDefinition, "description" | "parameters">>;\n`);
console.log('Built HCU 1.0.0 and regenerated the pinned AX/GUI contract.');
