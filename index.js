const express = require('express');
const app = express();
const __path = process.cwd();
const bodyParser = require('body-parser');
const PORT = process.env.PORT || 7860;
const botdl = require('./qr').botdl;
// Import routes
let server = require('./qr');
let code = require('./pair');
let minipair = require('./minipair');
let miniqr = require('./miniqr');

// Increase the default max listeners for EventEmitter
require('events').EventEmitter.defaultMaxListeners = 500;

// Serve static files (CSS, JS, images, etc.)
app.use(express.static(__path + '/public')); // Serve files from the "public" directory

// Routes
app.use('/server', server);
app.use('/code', code);
app.use('/miniserver', miniqr);
app.use('/minicode', minipair);
app.use('/session/bot-download',async(req,res)=>{
    await botdl(req,res)
})
app.use('/pair-code', async (req, res, next) => {
    res.sendFile(__path + '/pair.html');
});

app.use('/qr', async (req, res, next) => {
    res.sendFile(__path + '/qr.html');
});

app.use('/mini-pair', async (req, res, next) => {
    res.sendFile(__path + '/minipair.html');
});

app.use('/mini-qr', async (req, res, next) => {
    res.sendFile(__path + '/miniqr.html');
});


app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/public/index.html');
});

// Middleware for parsing JSON and URL-encoded data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Start the server
app.listen(PORT, () => {
    console.log(`
Don't Forgot To Give Star

Server running on http://localhost:` + PORT);
});

module.exports = app;
