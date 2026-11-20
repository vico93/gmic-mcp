import { spawn } from 'node:child_process';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'echo') {
  process.stdout.write(JSON.stringify(args));
} else if (mode === 'sleep') {
  setTimeout(() => process.stdout.write('finished'), Number(args[0]));
} else if (mode === 'error') {
  process.stderr.write('fixture failure');
  process.exitCode = 7;
} else if (mode === 'logs') {
  process.stdout.write('é'.repeat(25_000) + 'END');
  process.stderr.write('x'.repeat(25_000) + 'TAIL');
} else if (mode === 'tree') {
  const child = spawn(process.execPath, [process.argv[1], 'sleep', '10000'], { stdio: 'inherit' });
  process.stdout.write(`CHILD:${child.pid}\n`);
  setTimeout(() => {}, 10000);
} else {
  process.exitCode = 2;
}
