var socket = null;

let map = null;

//Prepare game
var app = new Vue({
    el: '#game',
    data: {
        connected: false,
        //state: {state: {currentClientMode: 2, gameState: 1}, isAdmin: true, player: {name: "me", currentScore: 50, guess: null}, otherPlayers: [{name: "1", currentScore: 20, guess: null},{name: "2", currentScore: 60, guess: null},{name: "3", currentScore: 40, guess: null},{name: "4", currentScore: 40, guess: null}]},
        state: {state: {currentClientMode: 2, gameState: 2}, isAdmin: true, player: {name: "me", currentScore: 50, guess: {lat: 50.923406, lng: -1.401113}}, otherPlayers: [{name: "1", currentScore: 20, guess: {lat: 50.92341, lng: -1.401113}},{name: "2", currentScore: 60, guess: {lat: 50.92541, lng: -1.405113}},{name: "3", currentScore: 40, guess: {lat: 50.92341, lng: -1.411113}},{name: "4", currentScore: 40, guess: {lat: 50.93341, lng: -1.401193}}]},
        leaderboard: [{name: "placeholder", currentScore: 0}],
        registering: false,
        username: "",
        password: "",
        confirmPassword: "",
        code: "12345",
        errorMessage: "",
        //awnserPos: null,
        awnserPos: {lat: 50.923406, lng: -1.401113},
        /*
        messages: [],
        chatmessage: '',
        */
    },
    mounted: function() {
        connect(); 
    },
    methods: {
        /*
        handleChat(message) {
            if(this.messages.length + 1 > 10) {
                this.messages.pop();
            }
            this.messages.unshift(message);
        },
        chat() {
            socket.emit('chat',this.chatmessage);
            this.chatmessage = '';
        },
        */
       orderLeaderboard() {
        var players = this.state.otherPlayers;
        players.push(this.state.player);
        
        players.sort(function(x,y) {
            if (x.currentScore < y.currentScore) {
                return 1;
            }
            if (x.currentScore > y.currentScore) {
                return -1;
            }
            return 0;
        })
        
        this.leaderboard = players;
       },
       error(message) {
        this.errorMessage = message;
       },
       login() {
        socket.emit('login', [this.username,this.password]);
        this.password = "";
       },
       register() {
        if (this.password == this.confirmPassword) {
            socket.emit('register', [this.username,this.password]);
            this.password = "";
            this.confirmPassword = "";
        }
        else {
            this.error("Entered passwords aren't the same");
            this.password = "";
            this.confirmPassword = "";
        }
       },
       startRegister() {
        this.registering = true;
       },
       stopRegister() {
        this.registering = false;
       },
       startLobby() {
        socket.emit('start')
       },
       joinLobby() {
        socket.emit('join', code)
       },
       advance() {
        socket.emit('advance');
       },
       update(state) {
        this.state = state
        this.orderLeaderboard();
       }
    }
});

function connect() {
    //Prepare web socket
    socket = io();

    //Connect
    socket.on('connect', function() {
        //Set connected state to true
        app.connected = true;
        app.orderLeaderboard();
    });

    //Handle connection error
    socket.on('connect_error', function(message) {
        alert('Unable to connect: ' + message);
    });

    //handle state update
    socket.on('update', function(state) {
        app.update(state);
    });

    //Handle disconnection
    socket.on('disconnect', function() {
        alert('Disconnected');
        app.connected = false;
    });

    /*
    //Handle incoming chat message
    socket.on('chat', function(message) {
        app.handleChat(message);
    });
    */
};

//handle maps
function mapClicked(latLng) {
    if (app.state.player.guess == null) {
        map.panTo(latLng);
        app.state.player.guess = latLng;
        new google.maps.marker.AdvancedMarkerElement({
            map,
            position: latLng,
        });
        socket.emit("guess", latLng);
    }
};

function initMap() {
    if (document.getElementById('map') != null) {
        let soton = {lat: 50.923406, lng: -1.401113}
        map = new google.maps.Map(
            document.getElementById('map'), {zoom: 12, center: soton, mapId: "MAP_ID"}
        );

        //add guess markers
        if (app.state.player.guess != null) {
            new google.maps.marker.AdvancedMarkerElement({
                map,
                position: app.state.player.guess,
            });
        }
        
        for (const player of app.state.otherPlayers) {
            if (player.guess != null) {
                new google.maps.marker.AdvancedMarkerElement({
                    map,
                    position: player.guess,
                    //try to add image if possible
                });
            }
        }

        //if (app.awnserPos != null) {
        //    new google.maps.marker.AdvancedMarkerElement({
        //            map,
        //            position: app.awnserPos,
        //        });
        //}

        if (app.state.state.gameState == 1) {
            map.addListener("click", (e) => {
                mapClicked(e.latLng);
            });
        }
        return
    }
    setTimeout(initMap, 1000);
};
        
