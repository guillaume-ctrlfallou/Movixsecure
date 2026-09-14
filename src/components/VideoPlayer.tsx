import React from 'react';
import { getFrembedBase } from '../utils/frembedConfig';
import { EMBED_ALLOW, EMBED_SANDBOX } from '../utils/embedSandbox';

interface VideoPlayerProps {
  movieId: string;
}

// L'ancien `useEffect` de ce composant tentait d'écrire dans
// `iframe.contentWindow.document.head` pour y injecter `disable-devtool`
// depuis jsDelivr. L'iframe étant cross-origin, l'accès lève systématiquement
// une SecurityError : le code n'a jamais rien injecté. Il a été retiré plutôt
// que réparé — un anti-devtools ne protège rien (il s'enlève en une ligne dans
// la console) et il ajoutait une dépendance CDN tierce dans notre origine.

const VideoPlayer: React.FC<VideoPlayerProps> = ({ movieId }) => (
  <iframe
    src={`${getFrembedBase()}/api/film.php?id=${movieId}`}
    width="100%"
    height="500px"
    frameBorder="0"
    allowFullScreen
    scrolling="no"
    style={{ overflow: 'hidden' }}
    allow={EMBED_ALLOW}
    sandbox={EMBED_SANDBOX}
    referrerPolicy="strict-origin-when-cross-origin"
  />
);

export default VideoPlayer;
