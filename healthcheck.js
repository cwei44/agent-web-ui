'use strict';
const req=require('http').get({hostname:'127.0.0.1',port:Number(process.env.PORT || 8760),path:'/healthz',timeout:4000},res=>{res.resume();process.exitCode=res.statusCode===200?0:1;});
req.on('timeout',()=>req.destroy());req.on('error',()=>{process.exitCode=1;});
