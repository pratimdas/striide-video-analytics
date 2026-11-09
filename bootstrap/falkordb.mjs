import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const action=process.argv[2]||'help';
const help='Usage: node bootstrap/falkordb.mjs up|verify|status|stop\nThe app ontology importer is implemented by Cursor; see docs/00_LOCAL_FALKORDB_SETUP.md.';
if(action==='help'||action==='--help'){console.log(help);process.exit(0)}
if(!['up','verify','status','stop'].includes(action)){console.error(help);process.exit(1)}
try{
  if(!existsSync(resolve(root,'.env')))throw new Error('Copy .env.example to .env and set a local FalkorDB password first.');
  if(typeof process.loadEnvFile!=='function')throw new Error('Use a current Node LTS release with process.loadEnvFile support.');
  process.loadEnvFile(resolve(root,'.env'));
  // REDIS_ARGS is whitespace-split by the image. This local helper deliberately
  // accepts a simple password alphabet, rather than attempting shell escaping.
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(process.env.FALKORDB_PASSWORD||''))throw new Error('Set FALKORDB_PASSWORD to 16–128 letters, digits, underscores or hyphens.');
  if(process.env.FALKORDB_HOST&&process.env.FALKORDB_HOST!=='127.0.0.1'&&process.env.FALKORDB_HOST!=='localhost')throw new Error('This container helper is for a local FalkorDB host only.');
  for(const key of ['FALKORDB_PORT','FALKORDB_BROWSER_PORT']){
    const value=process.env[key];if(value&&(!/^\d+$/.test(value)||Number(value)<1||Number(value)>65535))throw new Error('Invalid local port setting.');
  }
  function docker(args,capture=false){
    const result=spawnSync('docker',['compose','--env-file',resolve(root,'.env'),'-f',resolve(root,'compose.falkordb.yaml'),...args],{cwd:root,shell:false,encoding:'utf8',stdio:capture?'pipe':'inherit',maxBuffer:8*1024*1024});
    if(result.error)throw new Error('Docker Desktop with Compose v2 must be installed and running.');
    if(result.status!==0)throw new Error('Docker command failed. Check the service and local configuration; credentials are not printed by this helper.');
    return result.stdout;
  }
  if(action==='up'){
    docker(['up','-d','--wait']);
    console.log('FalkorDB is healthy. Next run the app ontology importer, then this helper with verify.');
  }else if(action==='status')docker(['ps']);
  else if(action==='stop')docker(['stop']);
  else{
    const manifestPath=resolve(root,'data/ontology-import.local.json');
    if(!existsSync(manifestPath))throw new Error('No import manifest. Run npm run ontology:import after Cursor implements the application.');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const source=readFileSync(resolve(root,'data/striide-ontology-all.json'));
    const digest=createHash('sha256').update(source).digest('hex');
    const graph=JSON.parse(source.toString('utf8'));
    if(manifest.ready!==true||manifest.source_sha256!==digest)throw new Error('Import is incomplete or does not match the bundled ontology.');
    if(!/^striide_lab_[A-Za-z0-9_]+$/.test(manifest.graph_name||''))throw new Error('Import graph must be in the reserved striide_lab namespace.');
    function scalar(query){
      const raw=docker(['exec','-T','falkordb','redis-cli','--json','GRAPH.RO_QUERY',manifest.graph_name,query],true);
      const value=JSON.parse(raw);
      if(!Array.isArray(value)||!Array.isArray(value[1])||!Array.isArray(value[1][0]))throw new Error('Unexpected graph-query response; inspect the importer diagnostics.');
      return value[1][0][0];
    }
    const nodes=Number(scalar('MATCH (n) RETURN count(n)'));
    const edges=Number(scalar('MATCH ()-[r]->() RETURN count(r)'));
    if(nodes!==graph.nodes.length||edges!==graph.edges.length)throw new Error('Graph counts do not match the source.');
    const cricket=scalar('MATCH (n:Sport {uid: "sport:cricket"}) RETURN n.uid');
    if(cricket!=='sport:cricket')throw new Error('Cricket lookup failed.');
    const protocols=Number(scalar('MATCH (p:Protocol) WHERE p.uid STARTS WITH "protocol:cricket." RETURN count(p)'));
    if(!Number.isFinite(protocols)||protocols<1)throw new Error('Cricket protocol lookup failed.');
    console.log(JSON.stringify({verified:true,graph_name:manifest.graph_name,source_sha256:digest,node_count:nodes,edge_count:edges,cricket_protocol_count:protocols},null,2));
  }
}catch(error){console.error(error.message);process.exitCode=1}
