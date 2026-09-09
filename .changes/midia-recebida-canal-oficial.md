---
impacto: nada_mudou
secao: corrigido
titulo: Mídia recebida pelo canal oficial (Meta) agora chega com bytes
---

Áudio, imagem, vídeo e documento recebidos pelo canal oficial da Meta apareciam no inbox como bolha vazia — nem player, nem "mídia indisponível". Faltavam os mesmos três elos que o canal intermediado já teve consertados (`media_url` gravado no ingest, evento `media.persist_requested` emitido, e o adapter sabendo baixar pelo ID de mídia da Cloud API em duas chamadas autenticadas). Nenhuma ação do operador é necessária — o próximo áudio recebido já chega com o player normal.
