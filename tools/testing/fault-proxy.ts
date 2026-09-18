import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/** Test-owned loopback proxy. Cutting it never changes the upstream service. */
export class FaultProxy {
  private readonly sockets=new Set<Socket>();
  private readonly server:Server;
  private blocked=false;
  private blackholed=false;
  private listening=false;
  constructor(readonly upstreamHost:string,readonly upstreamPort:number){
    this.server=createServer(client=>{
      if(this.blocked){client.destroy();return;}
      const upstream=createConnection({host:this.upstreamHost,port:this.upstreamPort});
      this.sockets.add(client);this.sockets.add(upstream);
      const close=()=>{client.destroy();upstream.destroy();this.sockets.delete(client);this.sockets.delete(upstream);};
      client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
      client.pipe(upstream);upstream.pipe(client);
      if(this.blackholed){client.pause();upstream.pause();}
    });
  }
  async start():Promise<this>{await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',()=>{this.server.off('error',reject);this.listening=true;resolve();});});return this;}
  get port():number{const address=this.server.address();if(!address||typeof address==='string')throw new Error('Proxy is not listening');return (address as AddressInfo).port;}
  url(source:string):string{const url=new URL(source);url.hostname='127.0.0.1';url.port=String(this.port);return url.toString();}
  cut():void{this.blocked=true;this.blackholed=false;for(const socket of this.sockets)socket.destroy();this.sockets.clear();}
  /** Keep TCP established but stop forwarding bytes in either direction. */
  blackhole():void{this.blocked=false;this.blackholed=true;for(const socket of this.sockets)socket.pause();}
  recover():void{this.blocked=false;this.blackholed=false;for(const socket of this.sockets)socket.resume();}
  async close():Promise<void>{this.cut();if(this.listening){await new Promise<void>((resolve,reject)=>this.server.close(error=>error?reject(error):resolve()));this.listening=false;}}
}
