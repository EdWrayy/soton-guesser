'use strict';

//set up application
const express = require('express');
const app = express();

//set up sockets
const server = require('http').Server(app);
const io = require('socket.io')(server);
const request = require('request');

//set up signalr
const signalR = require('@microsoft/signalr');
const e = require('express');


//Setup static page handling
app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

//Handle client interface on /
app.get('/', (req, res) => {
    res.render('client');
});

//URL of backend API
const BACKEND_ENDPOINT = process.env.BACKEND || 'https://southampton-guesser-functions-awdkf4e5crf8b8bd.francecentral-01.azurewebsites.net';
const BACKEND_KEY = process.env.BACKEND_KEY || 'pIDE43MBnBZXsvp6vtqjzhmZO_viKFDHuhxtTKfD4FqjAzFu7M5e8g==';
const DURABLE_FUNCTIONS_ENDPOINT = process.env.DURABLE_FUNCTIONS_ENDPOINT || 'http://localhost:7071/api/';
const SIGNALR_ENDPOINT = process.env.SIGNALR_ENDPOINT || 'http://localhost:7071/api/';

// ---- Helper: always include function key in headers ----
function backendRequest(method, path, options = {}, cb) {
    const url = `${BACKEND_ENDPOINT}${path}`;
    const reqOptions = {
        url,
        method,
        json: true,
        headers: {
            'x-functions-key': BACKEND_KEY,
            ...(options.headers || {}),
        },
        ...options,
    };

    return request(reqOptions, cb);
}

//Server state
let registeredPlayers = [];
let loggedinPlayers = new Map();

let playerToId = new Map();
let idToPlayer = new Map();

let admins = [];
let games = [];
let gameToAdmin = new Map();
let adminToGame = new Map();
let gameToPlayers = new Map();
let playerToGame = new Map();

let playerToState = new Map();
let gameToState = new Map();

let playerToSignalR = new Map();
let gameToSettings = new Map();
let gameToCurrentLocation = new Map();

let playersToSockets = new Map();
let socketsToPlayers = new Map();

let gameToOrchestrator = new Map();
let orchestratorToGame = new Map();

let orchestratorToSignalURL = new Map();
let orchestratorToConnection = new Map();
let connectionToOrchestrator = new Map();


//Start the server
function startServer() {
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

//Advance game state
function advance(game) {
    let state = gameToState.get(game);
    if (state == 0){
        startGameOrchestratorAPI(game);
        updateAll(game);
    }
    else if (state == 1){
        // depends on orchestrator
    }
    else if (state == 2){
        startScoring(game);
    }
}

function startGuessing(game, location){
    let players = gameToPlayers.get(game);
    gameToCurrentLocation.set(game, location);
    gameToState.set(game, 1);
    for (let i = 0; i < players.length; i++){
        let socket = playersToSockets.get(players[i]);
        let time = gameToSettings.get(game)['countdown'];
        socket.emit("guess", getState(players[i]), location, time);
    }
}

function startScoring(game){
    let players = gameToPlayers.get(game);
    gameToState.set(game, 3);
    for (let i = 0; i < players.length; i++){
        let socket = playersToSockets.get(players[i]);
        socket.emit("scores", getState(players[i]));
    }
}

//Update all clients
function updateAll(game){
    for (let player of gameToPlayers.get(game)){
        updateClient(player);
    }
}

function updateClient(player){
    const socket = playersToSockets.get(player);
    const data = getState(player);
    socket.emit('update', data);
}

function getState(player){
    const playerState = loggedinPlayers.get(player);
    const game = playerToGame.get(player);
    if (game == null){
        return {state: {currentClientMode: playerToState.get(player)}, isAdmin: false, player: playerState, otherPlayers: []};
    }
    console.log("Getting state for player " + player + " in game " + game);
    const gameState = gameToState.get(game);
    const isAdmin = admins.includes(player);
    const playerMode = playerToState.get(player);
    const playerIndex = gameToPlayers.get(game).indexOf(player);
    //const otherPlayers = gameToPlayers.get(game).splice(playerIndex, 1);
    const otherPlayers = [];
    for(const otherPlayer of gameToPlayers.get(game)) {
        const info = loggedinPlayers.get(otherPlayer);
        if (info['name'] != player) {
            otherPlayers.push(info);
        }
    }
    return {state: {currentClientMode: playerMode, gameState: gameState}, isAdmin: isAdmin, player: playerState, otherPlayers: otherPlayers};
}


//Start a session
function startSession(admin, apiResponse) {
    let lobbyCode = apiResponse['matchCode'];
    let signalR = apiResponse['signalR'];
    let matchSettings = apiResponse['matchSettings'];

    admins.push(admin);

    games.push(lobbyCode);
    gameToAdmin.set(lobbyCode, admin);
    gameToPlayers.set(lobbyCode, [admin]);
    gameToState.set(lobbyCode, 0);
    adminToGame.set(admin, lobbyCode);
    playerToGame.set(admin, lobbyCode);

    playerToSignalR.set(admin, signalR);
    gameToSettings.set(lobbyCode, matchSettings);

    playerToState.set(admin, 2);
    let adminSocket = playersToSockets.get(admin);
    adminSocket.emit('lobby', getState(admin), lobbyCode);

    updateAll(lobbyCode);
}

function joinSession(player, game, apiResponse) {
    let signalR = apiResponse['signalR'];

    let otherPlayers = gameToPlayers.get(game);
    otherPlayers.push(player)
    gameToPlayers.set(game, otherPlayers);
    playerToGame.set(player, game);

    playerToSignalR.set(player, signalR);

    playerToState.set(player, 2);
    let playerSocket = playersToSockets.get(player);
    playerSocket.emit('lobby', getState(player), game);

    updateAll(game);
}

function register(socket, username){
    registeredPlayers.push(username);

    playersToSockets.set(username, socket);
    socketsToPlayers.set(socket, username);

    playerToState.set(username, 0);
}

function login(socket, username, password, responseBody){
    if (loggedinPlayers.has(username)){
        error(socket, "This client is already logged in", false);
    }
    else{
        let player_state = {name: username, currentScore: 0, guess: null};
        let userId = responseBody['userId'];
        playerToId.set(username, userId);
        idToPlayer.set(userId, username);
        loggedinPlayers.set(username, player_state);
        playersToSockets.set(username, socket);
        socketsToPlayers.set(socket, username);
        playerToState.set(username, 1);
        console.log("Player " + username + " logged in with id " + userId);
        socket.emit('menu', getState(username));
    }
}

function returnToMenu(socket){
    let player = socketsToPlayers.get(socket);
    if (playerToGame.has(player)){
        let game = playerToGame.get(player);
        leaveGameAPI(socket);
        let playersList = gameToPlayers.get(game);
        let playerIndex = playersList.indexOf(player);
        gameToPlayers.set(game, playersList.splice(playerIndex, 1));
        playerToGame.delete(player);
        playerToSignalR.delete(player);

        if (admins.includes(player)){
            admins.splice(admins.indexOf(player), 1);
            adminToGame.delete(player);
            gameToAdmin.delete(game);
        }
        updateAll(game);
    }
    playerToState.set(player, 1);
    updateClient(player);
}

function startAnswers(game, roundResults){
    let players = gameToPlayers.get(game);
    gameToState.set(game, 2);
    increaseScores(roundResults);
    for (let i = 0; i < players.length; i++){
        var socket = playersToSockets.get(players[i]);
        socket.emit("awnsers", getState(players[i]), roundResults);
    }
}

function increaseScores(roundResults){
    for (let i = 0; i < roundResults.length; i++){
        var result = roundResults[i];
        var player = result['player_id'];
        var score = result['data'];
        var playerState = loggedinPlayers.get(player);
        loggedinPlayers.set(player, {name: playerState['name'], currentScore: (playerState['currentScore'] + score), guess: playerState['guess']});
    }
}

function concludeGame(game){
    var admin = gameToAdmin.get(game);
    var players = gameToPlayers.get(game);
    var orchestrator = gameToOrchestrator.get(game);
    var connection = orchestratorToConnection.get(game);

    if (admin != null){
        adminToGame.delete(admin);
    }
    if (players != null){
        for (let i = 0; i < players.length; i++){
            var player = players[i];
            playerToGame.delete(player);
        }
    }
    if (connection != null){
        connectionToOrchestrator.delete(connection);
    }
    if (orchestrator != null){
        orchestratorToConnection.delete(orchestrator);
    }

    gameToAdmin.delete(game);
    gameToPlayers.delete(game);
    gameToOrchestrator.delete(game);
    gameToCurrentLocation.delete(game);
    gameToSettings.delete(game);
    gameToState.delete(game);
}


function error(socket, message, halt){
    socket.emit("fail", message);
    if (halt){
        socket.disconnect();
    }
}

//API functions
function createLobbyAPI(socket, username){
    var userId = playerToId.get(username);
    backendRequest('POST', '/create_lobby', {
        body: { userId: userId }
    }, function(err, response, body){
        console.log(body);
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if (body && body['result']){
            startSession(username, body);
        }
        /*
        //TODO - temp remove for testing
        else if (!body['result']){
            startSession(username,{"result": true, "msg": "OK", "matchCode": "testmatchid", "signalR": {
                    "url": "testurl",
                    "accessToken": "testtoken"
                }, "matchSettings": {"noOfRounds":8, "maxPlayers":8, "countdown":60}})
        }
        //end temp
        */
        else{
            error(socket, (body && body['msg']) || "Failed to create lobby", false);
        }
    });
}

function joinGameAPI(socket, username, game){
    var playerId = playerToId.get(username);
    backendRequest('POST', '/join_game', {
        body: { matchCode: game, playerId: playerId }
    }, function(err, response, body){
        console.log(err);
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        console.log(body);
        if(body && body['result']){
            joinSession(username, game, body);
        }
        /*
        //TODO - temp remove for testing
        else if (!body['result']){
            joinSession(username, game,{"result": true, "msg": "OK", "matchCode": "testmatchid", "signalR": {
                    "url": "testurl",
                    "accessToken": "testtoken"
                }, "matchSettings": {"noOfRounds":8, "maxPlayers":8, "countdown":60}})
        }
        //end temp
        */
        else{
            error(socket, (body && body['msg']) || "Failed to join game", false);
        }
    });
}

function registerPlayerAPI(socket, username, password){
    backendRequest('POST', '/register', {
        body: { username: username, password: password }
    }, function(err, response, body){
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if (response.statusCode !== 200 && response.statusCode !== 201){
            error(socket, "Registration failed with status code " + response.statusCode, false);
            return;
        }
        if(body && body['result']){
            register(socket, username);
        }
        else{
            error(socket, (body && body['msg']) || "Registration failed", false);
        }
    });
}

function loginPlayerAPI(socket, username, password){
    backendRequest('POST', '/login', {
        body: { username: username, password: password }
    }, function(err, response, body){
        console.log(body);
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if (response.statusCode !== 200){
            error(socket, "Login failed with status code " + response.statusCode, false);
            return;
        }
        if(body && body['result']){
            login(socket, username, password, body);
        }
        else{
            error(socket, (body && body['msg']) || "Login failed", false);
        }
    });
}

function uploadImageAPI(socket, data){
    backendRequest('POST', '/create_place', {
        body: data
    }, function(err, response, body){
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if(body && body['result']){
            console.log("Image successfully uploaded at: " + body['url']);
        }
        else{
            error(socket, (body && body['msg']) || "Upload failed", false);
        }
    });
}

function leaveGameAPI(socket){
    var player = socketsToPlayers.get(socket);
    var playerId = playerToId.get(player);
    var game = playerToGame.get(player);
    backendRequest('POST', '/quit_game', {
        body: { matchCode: game, playerId: playerId }
    }, function(err, response, body){
        if (err){
            console.log("Error leaving game in backend:", err);
            return;
        }
        if(body && body['result']){
            console.log("Left game in the backend");
        }
        else{
            error(socket, (body && body['msg']) || "Failed to leave game", false);
        }
    });
}

function updateLeaderboardAPI(socket, timeframe){
    backendRequest('GET', '/leaderboard', {
        qs: { scope: timeframe, limit: 10 }
    }, function(err, response, body){
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if (body && body['result']){
            socket.emit('leaderboard', body['top']);
        }
        else{
            error(socket, (body && body['msg']) || "Failed to get leaderboard", false);
        }
    });
}

function makeGuessAPI(socket, guess){
    let player = socketsToPlayers.get(socket);
    let playerId = playerToId.get(player);
    let game = playerToGame.get(player);

    backendRequest('POST', '/guess', {
        body: { matchCode: game, playerId: playerId, guess: guess }
    }, function(err, response, body){
        if (err){
            console.log("Something went wrong when guessing:", err);
            return;
        }
        if(body && body['result']){
            console.log("Guess successfully sent");
        }
        else{
            console.log("Backend rejected guess:", body && body['msg']);
        }
    });
}

function getLocationAPI(locationId, cb){
    backendRequest('GET', '/get_place', {
        qs: { id: locationId }
    }, function(err, response, body){
        if (err) return cb(err);
        if (body && body['result']){
            return cb(null, body['place']);
        }
        return cb(new Error((body && body['msg']) || "Error in get location"));
    });
}

function resultsAPI(game){
    backendRequest('POST', '/results', {
        body: { matchCode: game }
    }, function(err, response, body){
        if(body && body['result']){
            concludeGame(game);
        }
        else{
            console.log((body && body['msg']) || err);
        }
    });
}

function startGameOrchestratorAPI(game){
    var settings = gameToSettings.get(game);
    var numRounds = settings['noOfRounds'];
    var timeRounds = settings['countdown'];

    //Needs to be fixed next - currently calling back end not durable function - I think this issue was casued when the backend request function was added.
    backendRequest('POST', '/start_game_trigger', {
        body: { gameId: game, rounds: numRounds, time: timeRounds }
    }, function(err, response, body){
        if (err){
            console.log("Error starting orchestrator:", err);
            return;
        }
        if (response.statusCode == 202){
            var orchestratorId = body['Id'];
            gameToOrchestrator.set(game, body);
            orchestratorToGame.set(orchestratorId, game);
            orchestratorToSignalURL.set(orchestratorId, "This is where the URL will go");

            const connection = new signalR.HubConnectionBuilder()
                .withUrl(orchestratorToSignalURL.get(orchestratorId))
                .build();

            connection.on("newRound", (data) => {
                var locationId = data[1];
                var gameId = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                getLocationAPI(locationId, (err, location) => {
                    if (err){
                        console.log("Something went wrong when getting location", err);
                        return;
                    }
                    startGuessing(gameId, location);
                });
            });

            connection.on("endRound", (data) => {
                var game = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                var players = gameToPlayers.get(game);
                for (let i = 0; i < players.length; i++){
                    var socket = playersToSockets.get(players[i]);
                    socket.emit("roundEnd");
                }
            });

            connection.on("updateLeaderboard", (data) => {
                var game = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                var roundResults = data[0];
                startAnswers(game, roundResults);
            });

            connection.on("gameOver", (data) => {
                var game = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                resultsAPI(game);
            });

            orchestratorToConnection.set(orchestratorId, connection);
            connectionToOrchestrator.set(connection, orchestratorId);
        }
    });
}

//Handle new connection
io.on('connection', socket => {
    console.log('New connection');

    socket.on('start', (username) => {
        createLobbyAPI(socket, username);
    });

    socket.on('join', (username, game) => {
        joinGameAPI(socket, username, game);
    });

    socket.on('register', (username, password) => {
        registerPlayerAPI(socket, username, password);
    });

    socket.on('login', (username, password) => {
        loginPlayerAPI(socket, username, password);
    });

    socket.on('menu', ()=> {
        returnToMenu(socket);
    });

    socket.on('toUpload', () => {
        let player = socketsToPlayers.get(socket);
        playerToState.set(player, 3);
        socket.emit('upload', getState(player));
    });

    socket.on('upload', (data) => {
        uploadImageAPI(socket, data);
    });

    socket.on('leaderboard', (timeframe) => {
        updateLeaderboardAPI(socket, timeframe);
    });

    socket.on('guess', (guessLoc) => {
        makeGuessAPI(socket, guessLoc);
    });

    socket.on('advance', () => {
        var player = socketsToPlayers.get(socket);
        var game = playerToGame.get(player);
        advance(game);
    });

    socket.on('disconnect', () => {
        loggedinPlayers.delete(socketsToPlayers.get(socket));
    });
});

//Start server
if (module === require.main) {
    startServer();
}

module.exports = server;
