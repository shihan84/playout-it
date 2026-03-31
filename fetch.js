import https from 'https';

https.get('https://flussonic.com/doc/', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const matches = data.match(/href="([^"]*)"/g);
    if (matches) {
      matches.forEach(m => {
        if (m.toLowerCase().includes('playlist')) {
          console.log(m);
        }
      });
    }
  });
});
