import type { ApiError } from '@bestword/contracts';
export class HttpError extends Error {
  constructor(public readonly statusCode:number,public readonly code:string,message:string){super(message);this.name='HttpError';}
  toJSON():ApiError{return {code:this.code,message:this.message};}
}
export function isPgError(error:unknown,code:string):boolean{return typeof error==='object'&&error!==null&&'code'in error&&error.code===code;}
