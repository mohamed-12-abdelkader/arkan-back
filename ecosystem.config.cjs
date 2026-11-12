// PM2 process file — production: `pm2 start ecosystem.config.cjs && pm2 save`
module.exports = {
  apps: [
    {
      name: 'arkan-api',
      script: 'dist/index.js',
      node_args: '--use-system-ca',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 8090,
      },
      max_memory_restart: '600M',
      time: true,
    },
  ],
};
