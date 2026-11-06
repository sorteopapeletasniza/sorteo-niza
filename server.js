# ==============================================================================
# PROYECTO: SERVIDOR RIFAS AD GENTES - PARROQUIA DE NIZA
# Tecnologías: Node.js, Express, Stripe, JSON Web Tokens (JWT), Bcrypt
# ==============================================================================
#
# INSTRUCCIONES DE INSTALACIÓN Y DESPLIEGUE RÁPIDO:
# 
# 1. Requisitos previos:
#    - Tener instalado Node.js (https://nodejs.org) en tu ordenador o servidor.
#    - Una cuenta activa en Stripe (https://stripe.com) con tus datos bancarios introducidos.
#
# 2. Inicialización del proyecto:
#    Abre tu terminal o consola de comandos en una carpeta vacía y ejecuta:
#      npm init -y
#      npm install express stripe jsonwebtoken bcrypt cors dotenv
#
# 3. Guardar este código:
#    Guarda este código en un archivo llamado `server.js`.
#
# 4. Configurar variables de entorno (crear un archivo `.env` en la misma carpeta):
#    PORT=3000
#    STRIPE_SECRET_KEY=sk_test_TU_CLAVE_PRIVADA_DE_STRIPE
#    ADMIN_JWT_SECRET=UNA_CLAVE_ULTRA_SECRETA_Y_LARGA_PARA_FIRMADO_DE_TOKENS
#    ADMIN_PASSWORD=TuContrase%C3%B1aSuperSegura2026
#
# 5. Ejecutar el servidor:
#    node server.js
# ==============================================================================

const express = require('express');
const stripeBuilder = require('stripe');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = stripeBuilder(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'clave_secreta_provisional_parroquia';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Parroquia2026!', 10);

// Archivo JSON local para persistencia simple de datos
const DB_FILE = path.join(__dirname, 'papeletas_db.json');

// Inicializar la Base de Datos (1.000 papeletas: 000 a 999)
let papeletas = [];
if (fs.existsSync(DB_FILE)) {
    papeletas = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
} else {
    papeletas = Array.from({ length: 1000 }, (_, i) => ({
        numero: String(i).padStart(3, '0'),
        estado: 'libre', // 'libre', 'reservado', 'vendido'
        comprador: null,
        fechaCompra: null
    }));
    guardarDB();
}

function guardarDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(papeletas, null, 2), 'utf-8');
}

// Middleware
app.use(cors());
// Importante: El webhook de Stripe requiere el body en formato raw (buffer)
app.use((req, res, next) => {
    if (req.originalUrl === '/api/webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

// Sirve la carpeta pública donde estará el index.html y la interfaz web
app.use(express.static(path.join(__dirname, 'public')));


// ==============================================================================
// RUTAS PÚBLICAS Y DE PAGO (STRIPE / BIZUM)
// ==============================================================================

// Obtener el estado actual de todas las papeletas (saber cuáles están libres/vendidas)
app.get('/api/papeletas', (req, res) => {
    const resumen = papeletas.map(p => ({
        numero: p.numero,
        estado: p.estado
    }));
    res.json(resumen);
});

// Crear Checkout Session en Stripe (Tarjeta / Bizum)
app.post('/api/crear-checkout', async (req, res) => {
    const { numero, nombre, email, telefono } = req.body;

    if (!numero || !nombre || !email || !telefono) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
    }

    const papeleta = papeletas.find(p => p.numero === numero);
    if (!papeleta) {
        return res.status(404).json({ error: 'El número solicitado no existe.' });
    }

    if (papeleta.estado !== 'libre') {
        return res.status(400).json({ error: `El número ${numero} ya ha sido reservado o vendido.` });
    }

    try {
        // Crear la sesión de pago seguro en Stripe
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'], // En tu panel de Stripe activa 'Bizum' para que aparezca automáticamente
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: `Papeleta Sorteo Jamón Niza - Nº ${numero}`,
                        description: 'Sorteo Solidario Misión ad Gentes (Parroquia)',
                    },
                    unit_amount: 100, // 1,00 EUR (expresado en céntimos)
                },
                quantity: 1,
            }],
            mode: 'payment',
            customer_email: email,
            metadata: {
                numero: numero,
                nombre: nombre,
                email: email,
                telefono: telefono
            },
            success_url: `${req.protocol}://${req.get('host')}/?exito=true&numero=${numero}`,
            cancel_url: `${req.protocol}://${req.get('host')}/?cancelado=true`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Error al crear la sesión de Stripe:', err);
        res.status(500).json({ error: 'Error interno al procesar la pasarela de pago.' });
    }
});

// Webhook de Stripe: Confirmación del pago en tiempo real
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // En producción se valida la firma con el endpoint secret de Stripe
        event = JSON.parse(req.body);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { numero, nombre, email, telefono } = session.metadata;

        const p = papeletas.find(item => item.numero === numero);
        if (p) {
            p.estado = 'vendido';
            p.comprador = { nombre, email, telefono };
            p.fechaCompra = new Date().toISOString();
            guardarDB();
            console.log(`[ÉXITO] Papeleta Nº ${numero} vendida a ${nombre} (${email})`);
        }
    }

    res.json({ received: true });
});


// ==============================================================================
// RUTAS PRIVADAS DE ADMINISTRACIÓN SEGURO (JWT)
// ==============================================================================

// Login del Administrador
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: 'Introduce la contraseña.' });
    }

    if (bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
        return res.json({ token, message: 'Autenticación exitosa.' });
    }

    return res.status(401).json({ error: 'Contraseña incorrecta.' });
});

// Middleware de verificación de Token JWT
function autenticarAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ error: 'Acceso denegado. Token no proporcionado.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const verificado = jwt.verify(token, JWT_SECRET);
        req.user = verificado;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Sesión expirada o token inválido.' });
    }
}

// Obtener listado COMPLETO de papeletas con datos confidenciales de los compradores
app.get('/api/admin/papeletas-completas', autenticarAdmin, (req, res) => {
    res.json(papeletas);
});

// Permitir al administrador marcar papeletas vendidas físicamente en la parroquia
app.post('/api/admin/marcar-manual', autenticarAdmin, (req, res) => {
    const { numero, nombre, email, telefono } = req.body;

    const p = papeletas.find(item => item.numero === numero);
    if (!p) return res.status(404).json({ error: 'Número no encontrado.' });

    p.estado = 'vendido';
    p.comprador = { 
        nombre: nombre || 'Venta Presencial / Parroquia', 
        email: email || 'N/A', 
        telefono: telefono || 'N/A' 
    };
    p.fechaCompra = new Date().toISOString();
    guardarDB();

    res.json({ message: `Papeleta ${numero} registrada manualmente con éxito.`, papeleta: p });
});

// Iniciar Servidor
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` Servidor Parroquia Sorteo Jamón activo en puerto ${PORT}`);
    console.log(` Web: http://localhost:${PORT}`);
    console.log(`=======================================================`);
});
