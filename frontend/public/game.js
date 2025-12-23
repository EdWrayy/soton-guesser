var socket = null;

//Prepare game
var app = new Vue({
    el: '#game',
    data: {
        connected: false,
        state: {state: {currentClientMode: 0, gameState: 3}, isAdmin: true, player: {name: "me", currentScore: 50}, otherPlayers: [{name: "1", currentScore: 20},{name: "2", currentScore: 60},{name: "3", currentScore: 40},{name: "4", currentScore: 40}]},
        leaderboard: [{name: "placeholder", currentScore: 0}],
        registering: false,
        username: "",
        password: "",
        confirmPassword: "",
        code: "12345",
        errorMessage: "",
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
        socket.emmit('login', [this.username,this.password]);
        this.password = "";
       },
       register() {
        if (this.password == this.confirmPassword) {
            socket.emmit('register', [this.username,this.password]);
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
        socket.emmit('start')
       },
       joinLobby() {
        socket.emmit('join', code)
       },
       advance() {
        socket.emmit('advance');
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
}
