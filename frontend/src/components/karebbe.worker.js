import { parseKarebbe } from './karebbeParser.mjs';
self.onmessage = async ({data: file}) => {
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('Ukuran maksimum file 100 MB.');
    const result = parseKarebbe(await file.text(), count => self.postMessage({type: 'progress', count}));
    self.postMessage({type: 'done', result: {...result, name: file.name}}, [result.times.buffer, ...result.columns.map(c => c.values.buffer)]);
  } catch (error) { self.postMessage({type: 'error', message: error instanceof Error ? error.message : 'Impor gagal.'}); }
};
