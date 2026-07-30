const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')({cors:{origin:"*"}});

// app.set('view engine', 'cjs');

app.get('/',(req,res) => {
    res.send('Server is running');
})

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});