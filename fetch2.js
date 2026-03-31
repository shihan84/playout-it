import https from 'https';

const options = {
  hostname: 'html.duckduckgo.com',
  path: '/html/?q=flussonic+playlist.txt+format',
  headers: { 'User-Agent': 'Mozilla/5.0' }
};

https.get(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const matches = data.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/g);
    if (matches) {
      matches.forEach(m => console.log(m.replace(/<[^>]+>/g, '')));
    }
  });
});
