import util from 'util';

type Sink = { write(chunk: string): unknown };

// LOG_FORMAT=json: every console line becomes one JSON object, for journald/log shippers.
export function installJsonLogs(out: Sink = process.stdout, err: Sink = process.stderr) {
  const emit = (sink: Sink, level: string) => (...args: unknown[]) => {
    sink.write(JSON.stringify({ time: new Date().toISOString(), level, msg: util.format(...args) }) + '\n');
  };
  console.log = emit(out, 'info');
  console.info = emit(out, 'info');
  console.warn = emit(err, 'warn');
  console.error = emit(err, 'error');
}
