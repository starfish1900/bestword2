//! Offline compiler for the canonical GADDAG language. No runtime dependencies.
mod sha256;

use std::{collections::HashMap, env, fs, time::Instant};

const HEADER_BYTES: usize = 128;
const MAX_U24: usize = 0x00ff_ffff;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Node { terminal: bool, edges: Vec<(u8, u32)> }

struct Pending { incoming: u8, node: Node }

fn read_words(raw: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let text = std::str::from_utf8(raw).map_err(|_| "Dictionary must be UTF-8 ASCII".to_string())?;
    let mut words: Vec<Vec<u8>> = Vec::new();
    for (line_no, line) in text.lines().enumerate() {
        if !(3..=15).contains(&line.len()) || !line.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(format!("Line {} must contain one uppercase A-Z word of length 3-15", line_no+1));
        }
        if words.last().is_some_and(|previous| previous.as_slice() >= line.as_bytes()) {
            return Err(format!("Line {} is duplicated or not in increasing ASCII order", line_no+1));
        }
        words.push(line.as_bytes().to_vec());
    }
    if words.is_empty() { return Err("Empty dictionary".into()); }
    Ok(words)
}

fn transforms(words: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let count: usize = words.iter().map(Vec::len).sum();
    let mut strings = Vec::with_capacity(count);
    for word in words {
        for split in 1..=word.len() {
            let mut encoded = Vec::with_capacity(word.len()+1);
            encoded.extend(word[..split].iter().rev().map(|c| c-b'A'+1));
            if split < word.len() {
                encoded.push(0); // '+' sorts before A-Z.
                encoded.extend(word[split..].iter().map(|c| c-b'A'+1));
            }
            strings.push(encoded);
        }
    }
    strings.sort_unstable();
    strings
}

// Daciuk et al., incremental construction for sorted input: only the current
// word's unchecked suffix is mutable; its completed states are registered and
// merged bottom-up as soon as the next word diverges.
fn minimize(strings: &[Vec<u8>]) -> (Vec<Node>, u32) {
    let mut nodes = Vec::<Node>::new();
    let mut register = HashMap::<Node,u32>::new();
    let mut path = vec![Pending { incoming: 0, node: Node { terminal:false,edges:Vec::new() } }];
    let mut previous: &[u8] = &[];
    fn intern(node: Node, nodes: &mut Vec<Node>, register: &mut HashMap<Node,u32>) -> u32 {
        if let Some(&id) = register.get(&node) { return id; }
        let id = nodes.len() as u32;
        nodes.push(node.clone());
        register.insert(node,id);
        id
    }
    fn finish_suffix(depth: usize, path: &mut Vec<Pending>, nodes: &mut Vec<Node>, register: &mut HashMap<Node,u32>) {
        while path.len() > depth+1 {
            let child = path.pop().unwrap();
            let id = intern(child.node,nodes,register);
            path.last_mut().unwrap().node.edges.push((child.incoming,id));
        }
    }
    for word in strings {
        let common = previous.iter().zip(word).take_while(|(a,b)| a==b).count();
        finish_suffix(common,&mut path,&mut nodes,&mut register);
        for &label in &word[common..] {
            path.push(Pending { incoming:label,node:Node { terminal:false,edges:Vec::new() } });
        }
        path.last_mut().unwrap().node.terminal = true;
        previous = word;
    }
    finish_suffix(0,&mut path,&mut nodes,&mut register);
    let root = intern(path.pop().unwrap().node,&mut nodes,&mut register);
    (nodes,root)
}

fn accepts(nodes: &[Node], root: u32, word: &[u8]) -> bool {
    let mut state = root;
    for &label in word {
        let node = &nodes[state as usize];
        let Ok(index) = node.edges.binary_search_by_key(&label, |&(l,_)| l) else { return false; };
        state = node.edges[index].1;
    }
    nodes[state as usize].terminal
}

// Compare the entire accepted language, including terminal prefixes, in order.
// A dictionary membership pass alone would miss unwanted extra accepted words.
fn audit_language(nodes: &[Node], root: u32, expected: &[Vec<u8>]) -> Result<(),String> {
    fn visit(nodes: &[Node], id: u32, path: &mut Vec<u8>, expected: &[Vec<u8>], seen: &mut usize) -> Result<(),String> {
        let node = &nodes[id as usize];
        if node.terminal {
            if expected.get(*seen) != Some(path) { return Err(format!("Accepted language differs at string {}",*seen)); }
            *seen += 1;
        }
        for &(label,target) in &node.edges {
            if target >= id { return Err("Non-bottom-up or cyclic automaton".into()); }
            if path.len() >= 16 { return Err("Accepted path exceeds maximum length".into()); }
            path.push(label);
            visit(nodes,target,path,expected,seen)?;
            path.pop();
        }
        Ok(())
    }
    let mut seen = 0;
    visit(nodes,root,&mut Vec::new(),expected,&mut seen)?;
    if seen != expected.len() { return Err("Missing accepted strings".into()); }
    Ok(())
}

fn push_u24(output: &mut Vec<u8>, n: usize) -> Result<(),String> {
    if n > MAX_U24 { return Err("This corpus exceeds the 24-bit format limit".into()); }
    output.extend_from_slice(&(n as u32).to_le_bytes()[..3]);
    Ok(())
}

fn seeds_payload(words: &[Vec<u8>]) -> (Vec<u8>,usize) {
    let mut bytes = Vec::new();
    let mut previous: &[u8] = &[];
    let mut count = 0;
    for word in words.iter().filter(|w| (9..=12).contains(&w.len())) {
        let prefix = previous.iter().zip(word).take_while(|(a,b)| a==b).count();
        let suffix = &word[prefix..];
        bytes.push(((prefix as u8)<<4) | suffix.len() as u8);
        let mut accumulator = 0_u32;
        let mut bits = 0;
        for &letter in suffix {
            accumulator |= ((letter-b'A') as u32)<<bits;
            bits += 5;
            while bits >= 8 { bytes.push(accumulator as u8);accumulator >>= 8;bits -= 8; }
        }
        if bits > 0 { bytes.push(accumulator as u8); }
        previous=word;
        count+=1;
    }
    (bytes,count)
}

fn encode(nodes: &[Node], root: u32, words: &[Vec<u8>], source_hash: &[u8;32]) -> Result<Vec<u8>,String> {
    let edges: usize = nodes.iter().map(|n| n.edges.len()).sum();
    if nodes.len() > MAX_U24 || edges > MAX_U24 { return Err("Automaton exceeds 24-bit format limit".into()); }
    let (seeds,seed_count) = seeds_payload(words);
    let mut output = vec![0_u8;HEADER_BYTES];
    let mut edge_start = 0;
    for node in nodes {
        let mut mask = if node.terminal { 1_u32<<31 } else { 0 };
        for &(label,_) in &node.edges { mask |= 1_u32<<label; }
        output.extend_from_slice(&mask.to_le_bytes());
        push_u24(&mut output,edge_start)?;
        edge_start += node.edges.len();
    }
    let edge_offset = output.len();
    for node in nodes { for &(_,target) in &node.edges { push_u24(&mut output,target as usize)?; } }
    let seed_offset = output.len();
    output.extend_from_slice(&seeds);
    let payload_hash = sha256::digest(&output[HEADER_BYTES..]);
    let payload_len = output.len()-HEADER_BYTES;
    output[..8].copy_from_slice(b"BWGAD001");
    output[8..10].copy_from_slice(&1_u16.to_le_bytes());
    output[10..12].copy_from_slice(&(HEADER_BYTES as u16).to_le_bytes());
    for (offset,value) in [
        (12,0),(16,nodes.len()),(20,edges),(24,root as usize),(28,words.len()),
        (32,words.iter().map(Vec::len).sum()),(36,seed_count),(40,HEADER_BYTES),
        (44,edge_offset),(48,seed_offset),(52,seeds.len()),(60,payload_len),
    ] { output[offset..offset+4].copy_from_slice(&(value as u32).to_le_bytes()); }
    output[56]=15;output[57]=7;output[58]=3;
    output[64..96].copy_from_slice(source_hash);
    output[96..128].copy_from_slice(&payload_hash);
    Ok(output)
}

fn main() {
    if let Err(error) = run() { eprintln!("Lexicon compilation failed: {error}");std::process::exit(1); }
}

fn run() -> Result<(),String> {
    let args: Vec<String> = env::args().collect();
    if args.len()!=4 { return Err("Usage: bestword-lexicon-builder INPUT.txt OUTPUT.bin REPORT.json".into()); }
    let start = Instant::now();
    let raw = fs::read(&args[1]).map_err(|e| e.to_string())?;
    let words = read_words(&raw)?;
    let source_hash = sha256::digest(&raw);
    eprintln!("Read {} source words",words.len());
    let strings = transforms(&words);
    let transform_ms = start.elapsed().as_millis();
    eprintln!("Sorted {} canonical GADDAG strings",strings.len());
    let build_start = Instant::now();
    let (nodes,root) = minimize(&strings);
    let build_ms = build_start.elapsed().as_millis();
    let edges: usize = nodes.iter().map(|n| n.edges.len()).sum();
    eprintln!("Minimized to {} states, {} edges in {}ms",nodes.len(),edges,build_ms);
    let verify_start = Instant::now();
    for word in &strings { if !accepts(&nodes,root,word) { return Err("Rejected source transform".into()); } }
    for word in &words {
        let reverse: Vec<u8> = word.iter().rev().map(|c| c-b'A'+1).collect();
        if !accepts(&nodes,root,&reverse) { return Err("Rejected source word".into()); }
    }
    audit_language(&nodes,root,&strings)?;
    let verify_ms = verify_start.elapsed().as_millis();
    let bytes = encode(&nodes,root,&words,&source_hash)?;
    let binary_hash = sha256::hex(&sha256::digest(&bytes));
    fs::write(&args[2],&bytes).map_err(|e|e.to_string())?;
    let seed_count=words.iter().filter(|w| (9..=12).contains(&w.len())).count();
    let report = format!(concat!(
        "{{\n  \"formatVersion\":1,\n  \"algorithm\":\"Daciuk sorted incremental minimization\",\n",
        "  \"sourceSha256\":\"{}\",\n  \"binarySha256\":\"{}\",\n",
        "  \"words\":{},\n  \"transforms\":{},\n  \"seedWords\":{},\n",
        "  \"nodes\":{},\n  \"edges\":{},\n  \"binaryBytes\":{},\n",
        "  \"transformAndSortMs\":{},\n  \"minimizeMs\":{},\n  \"fullVerificationMs\":{},\n  \"totalMs\":{},\n",
        "  \"allWordsVerified\":true,\n  \"allTransformsVerified\":true,\n  \"acceptedLanguageExact\":true\n}}\n"),
        sha256::hex(&source_hash),binary_hash,words.len(),strings.len(),seed_count,nodes.len(),edges,bytes.len(),
        transform_ms,build_ms,verify_ms,start.elapsed().as_millis());
    fs::write(&args[3],report).map_err(|e|e.to_string())?;
    eprintln!("Wrote {} bytes; SHA256 {binary_hash}",bytes.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_transform_example() {
        let words=read_words(b"CARE\n").unwrap();
        let actual: Vec<String> = transforms(&words).iter().map(|s|s.iter().map(|c|if *c==0 {'+'} else {(c-1+b'A') as char}).collect()).collect();
        assert_eq!(actual,vec!["AC+RE","C+ARE","ERAC","RAC+E"]);
    }
    #[test]
    fn merged_suffixes_and_terminal_prefixes_preserve_exact_language() {
        let words=read_words(b"ARE\nCARE\nCARED\nCARS\nDARE\n").unwrap();
        let strings=transforms(&words);
        let (nodes,root)=minimize(&strings);
        audit_language(&nodes,root,&strings).unwrap();
        assert!(nodes.len()<strings.iter().map(Vec::len).sum::<usize>());
        assert!(!accepts(&nodes,root,&[26,26,26]));
        assert_eq!(encode(&nodes,root,&words,&sha256::digest(b"x")).unwrap(),encode(&nodes,root,&words,&sha256::digest(b"x")).unwrap());
    }
    #[test]
    fn malformed_dictionaries_are_rejected() {
        for text in ["", "AB\n", "lower\n", "AAA\nAAA\n", "ZZZ\nAAA\n", "AAA \n", "ABCDEFGHIJKLMNOP\n"] { assert!(read_words(text.as_bytes()).is_err()); }
        assert!(read_words(b"AAA\r\nBBB\r\n").is_ok());
    }
}
