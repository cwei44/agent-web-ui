#!/usr/bin/env node
if(process.argv.includes('auth')) { console.log(JSON.stringify({loggedIn:true}));process.exit(0); }
console.log('Claude native terminal ready '+JSON.stringify(process.argv.slice(2)));
process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',bytes=>process.stdout.write(bytes));
