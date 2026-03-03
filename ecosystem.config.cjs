module.exports = {
  apps: [
    {
      name: 'inquisia-backend',
      script: 'src/index.js',
      cwd: '/opt/inquisia-backend',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '/var/log/inquisia/error.log',
      out_file:   '/var/log/inquisia/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '512M',
      restart_delay: 3000,
    },
  ],
}
