/** A bounded legal-move finder for tests/load drivers; never shipped to players. */
import { evaluatePlacement,type EngineState } from '@bestword/engine';
import { BOARD_SIZE,isVowel,type Letter,type PlaceWordAction } from '@bestword/contracts';
import type { Gaddag } from '@bestword/lexicon';

export function findMove(state:EngineState,lexicon:Gaddag):PlaceWordAction|null {
  const rack=state.players[state.activeSeat].rack;
  const available=new Map<Letter,number>();for(const letter of rack)available.set(letter,(available.get(letter)??0)+1);
  const vowels=['A','E','I','O','U','Y'] as const;
  const choices=[...new Set<Letter>([...rack,...vowels])];
  let visits=0;const maxVisits=300000;
  for(const direction of ['H','V'] as const)for(let row=0;row<15;row++)for(let column=0;column<15;column++){
    const dr=direction==='V'?1:0,dc=direction==='H'?1:0;
    const at=(r:number,c:number):Letter|null=>r<0||c<0||r>=15||c>=15?null:state.board[r*15+c]??null;
    if(at(row-dr,column-dc))continue;
    const remaining=new Map(available);const vowelUsed=new Map<Letter,number>();
    function walk(r:number,c:number,node:number,word:string,placed:number,touched:boolean):PlaceWordAction|null {
      if(++visits>maxVisits)return null;
      if(word.length>=3&&placed>=2&&touched&&lexicon.isTerminal(node)&&!at(r,c)&&!state.principalHistory.includes(word)){
        const action:PlaceWordAction={type:'PLACE_WORD',row,column,direction,word};
        try{evaluatePlacement(state,state.activeSeat,action,lexicon);return action;}catch{/* explore another extension */}
      }
      if(r>=BOARD_SIZE||c>=BOARD_SIZE||word.length>=15)return null;
      const fixed=at(r,c);
      for(const letter of fixed?[fixed]:choices){
        if(!fixed&&(isVowel(letter)?(vowelUsed.get(letter)??0)>=state.bag[letter]:(remaining.get(letter)??0)<=0))continue;
        let next=lexicon.next(node,letter);if(next===null)continue;
        if(!word){next=lexicon.next(next,'+');if(next===null)continue;}
        let adjacent=Boolean(fixed);
        if(!fixed){
          let cross=letter;let rr=r-dc,cc=c-dr;
          while(at(rr,cc)){cross=at(rr,cc)!+cross;rr-=dc;cc-=dr;}
          rr=r+dc;cc=c+dr;while(at(rr,cc)){cross+=at(rr,cc)!;rr+=dc;cc+=dr;}
          if(cross.length>1&&!lexicon.has(cross))continue;
          adjacent=cross.length>1;
          if(isVowel(letter))vowelUsed.set(letter,(vowelUsed.get(letter)??0)+1);else remaining.set(letter,(remaining.get(letter)??0)-1);
        }
        const result=walk(r+dr,c+dc,next,word+letter,placed+(fixed?0:1),touched||adjacent);
        if(!fixed){if(isVowel(letter))vowelUsed.set(letter,vowelUsed.get(letter)!-1);else remaining.set(letter,remaining.get(letter)!+1);}
        if(result)return result;
      }
      return null;
    }
    const found=walk(row,column,lexicon.root,'',0,false);if(found)return found;
    if(visits>maxVisits)break;
  }
  return null;
}
