const express = require('express');
const { Client } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

// Aquí es donde Render inyectará tu dirección de Supabase
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

(async () => {
  try {
        await client.connect();
        console.log('Conectado a Supabase correctamente');
      // Crear tablas si no existen
      await client.query(`
            CREATE TABLE IF NOT EXISTS boletos (
                    id SERIAL PRIMARY KEY,
                            numero_boleto INTEGER UNIQUE NOT NULL,
                                    nombre_cliente TEXT NOT NULL,
                                            telefono_cliente TEXT NOT NULL,
                                                    estado_pago TEXT DEFAULT 'pendiente',
                                                            id_transaccion TEXT UNIQUE,
                                                                    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                                          );

                                                                                CREATE TABLE IF NOT EXISTS configuracion_rifa (
                                                                                        id SERIAL PRIMARY KEY,
                                                                                                nombre_rifa TEXT NOT NULL,
                                                                                                        precio_boleto DECIMAL(10,2) NOT NULL,
                                                                                                                total_boletos INTEGER NOT NULL,
                                                                                                                        fecha_sorteo TIMESTAMP
                                                                                                                              );
                                                                                                                                  `);
    console.log('Tablas creadas correctamente');
      } catch (err) {
        console.error('Error de conexión', err.stack);
      }
    })();

app.get('/', (req, res) => {
  res.send('<h1>¡Servidor de AUTORACER funcionando!</h1><p>Conectado a la base de datos de Supabase.</p>');
});

app.listen(port, () => {
  console.log(`App corriendo en puerto ${port}`);

});
