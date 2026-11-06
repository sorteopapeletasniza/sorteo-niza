// ==============================================================================
// PROYECTO: SERVIDOR RIFAS AD GENTES - PARROQUIA DE NIZA
// ==============================================================================

const express = require('express');
const stripeBuilder = require('stripe');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PUERTO || process.env.PORT || 3000;
const stripeKey = process.env.CLAVE_SECRETA_STRIPE || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
const stripe = stripeBuilder(stripeKey);
const JWT_SECRET = process.env.SECRETO_TOKEN_ADMIN || process.env.ADMIN_JWT_SECRET || 'clave_secreta_provisional_parroquia';
const adminPass = process.env.CONTRASENA_ADMIN || process.env.ADMIN_PASSWORD || 'Parroquia2026!';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(adminPass, 10);

const DB_FILE = path.join(__dirname, 'papeletas_db.json');

let papeletas = [];
if (fs.existsSync(DB_FILE)) {
    papeletas = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
} else {
    papeletas = Array.from({ length: 1000 }, (_, i) => ({
        numero: String(i).padStart(3, '0'),
        estado: 'libre',
        comprador: null,
        fechaCompra: null
    }));
    guardarDB();
}

function guardarDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(papeletas, null, 2), 'utf-8');
}

app.use(cors());
app.use((req, res, next) => {
    if (req.originalUrl === '/api/webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/papeletas', (req, res) => {
    const resumen = papeletas.map(p => ({
        numero: p.numero,
        estado: p.estado
    }));
    res.json(resumen);
});

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
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: `Papeleta Sorteo Jamón Niza - Nº ${numero}`,
                        description: 'Sorteo Solidario Misión ad Gentes (Parroquia)',
                    },
                    unit_amount: 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            customer_email: email,
            metadata: { numero, nombre, email, telefono },
            success_url: `${req.protocol}://${req.get('host')}/?exito=true&numero=${numero}`,
            cancel_url: `${req.protocol}://${req.get('host')}/?cancelado=true`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Error al crear la sesión de Stripe:', err);
        res.status(500).json({ error: 'Error interno al procesar la pasarela de pago.' });
    }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    let event;
    try {
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

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Introduce la contraseña.' });

    if (bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
        return res.json({ token, message: 'Autenticación exitosa.' });
    }

    return res.status(401).json({ error: 'Contraseña incorrecta.' });
});

function autenticarAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ error: 'Acceso denegado.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Sesión expirada.' });
    }
}

app.get('/api/admin/papeletas-completas', autenticarAdmin, (req, res) => {
    res.json(papeletas);
});

app.listen(PORT, () => {
    console.log(`Servidor de la Parroquia activo en puerto ${PORT}`);
});
