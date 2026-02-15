const express = require('express');
const { Client } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

// Aquí es donde Render inyectará tu dirección de Supabase
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

client.connect()
  .then(() => console.log('Conectado a Supabase correctamente'))
  .catch(err => console.error('Error de conexión', err.stack));

app.get('/', (req, res) => {
  res.send('<h1>¡Servidor de AUTORACER funcionando!</h1><p>Conectado a la base de datos de Supabase.</p>');
});

app.listen(port, () => {
  console.log(`App corriendo en puerto ${port}`);
});