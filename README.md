# Control horario

Tablero de fichajes de Salesdose. La página llama a `/api/board` y esa función lee Holded con la variable `HOLDED_API_KEY`. La clave no va en el repositorio.

En Vercel: importa este proyecto y crea la variable de entorno `HOLDED_API_KEY` con el token de Holded (Settings → Developers → Credentials). Luego despliega. La raíz abre el tablero.
