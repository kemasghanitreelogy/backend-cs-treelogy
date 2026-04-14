const app = require('./app');
const env = require('./config/env');

app.listen(env.port, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   Treelogy Wellness Truth Engine             ║
  ║   Running on port ${env.port}                       ║
  ║   Environment: ${env.nodeEnv.padEnd(21)}       ║
  ╚══════════════════════════════════════════════╝
  `);
});
