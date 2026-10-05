/**
 * FrenchStream helper module.
 * Extracted from server.js -- provides scraping functions for FrenchStream.
 * This is NOT an Express router; it exports plain functions used by tmdb.js.
 */

const cheerio = require('cheerio');
const axios = require('axios');

const { sourceUrl, sourceHost } = require('../config/sources');
const FRENCHSTREAM_BASE_URL = sourceUrl('frenchstream');
const FRENCHSTREAM_HOST = sourceHost('frenchstream');

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let makeRequestWithCorsFallback;
let axiosFrenchStreamRequest;
let findTvSeriesOnTMDB;

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.makeRequestWithCorsFallback) makeRequestWithCorsFallback = deps.makeRequestWithCorsFallback;
  if (deps.axiosFrenchStreamRequest) axiosFrenchStreamRequest = deps.axiosFrenchStreamRequest;
  if (deps.findTvSeriesOnTMDB) findTvSeriesOnTMDB = deps.findTvSeriesOnTMDB;
}

// ---------------------------------------------------------------------------
// getFrenchStreamMovie
// ---------------------------------------------------------------------------
async function getFrenchStreamMovie(imdbId) {
  try {
    const searchUrl = `${FRENCHSTREAM_BASE_URL}/xfsearch/${imdbId}`;

    const searchResponse = await makeRequestWithCorsFallback(searchUrl, { timeout: 5000, decompress: true });
    const $search = cheerio.load(searchResponse.data);

    // Find the movie link in search results
    let movieLink = null;
    $search('.short').each((index, element) => {
      const $element = $search(element);
      const link = $element.find('.short-poster').attr('href');
      if (link && !movieLink) {
        movieLink = link;
      }
    });

    if (!movieLink) {
      return { error: 'Movie not found on FrenchStream' };
    }

    const movieResponse = await makeRequestWithCorsFallback(movieLink, { timeout: 5000, decompress: true });
    const $movie = cheerio.load(movieResponse.data);

    // Extract iframe src using the specified XPath logic
    let iframeSrc = $movie('body > div:nth-child(2) > div:nth-child(1) > div > article > div:nth-child(1) > div > div > div:nth-child(1) > div > div > div > iframe').attr('src');

    if (!iframeSrc) {
      // Fallback selectors
      iframeSrc = $movie('iframe[src*="frenchcloud.cam"]').attr('src');
    }

    if (!iframeSrc) {
      // Try finding it in the tabs content if the structure is slightly different
      iframeSrc = $movie('.tabs-content iframe').attr('src');
    }

    if (!iframeSrc) {
      return { error: 'Iframe not found on movie page' };
    }

    // Fetch the iframe content (FrenchCloud page)
    const iframeResponse = await axios.get(iframeSrc, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': `${FRENCHSTREAM_BASE_URL}/`
      },
      timeout: 15000,
      decompress: true
    });

    const $iframe = cheerio.load(iframeResponse.data);
    const playerLinks = [];

    $iframe('._player-mirrors li').each((index, element) => {
      const $element = $iframe(element);
      const dataLink = $element.attr('data-link');
      const playerName = $element.text().trim();
      const isHD = $element.hasClass('fullhd');

      // Skip links that contain frenchcloud.cam (often the embed itself)
      if (!dataLink || dataLink.includes('frenchcloud.cam')) {
        return;
      }

      // Add protocol to links that start with //
      let formattedLink = dataLink;
      if (dataLink.startsWith('//')) {
        formattedLink = 'https:' + dataLink;
      }

      playerLinks.push({
        player: playerName,
        link: formattedLink,
        is_hd: isHD
      });
    });

    return {
      iframe_src: iframeSrc,
      player_links: playerLinks
    };

  } catch (error) {
    return { error: `Failed to fetch movie data: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// getFrenchStreamSeries
// ---------------------------------------------------------------------------
async function getFrenchStreamSeries(id) {
  try {
    const targetUrl = `${FRENCHSTREAM_BASE_URL}/xfsearch/${id}`;

    const response = await makeRequestWithCorsFallback(targetUrl, {
      timeout: 5000,
      decompress: true
    });

    const $ = cheerio.load(response.data);

    // Find all series in the search results
    const seriesList = [];
    $('.short').each(async (index, element) => {
      try {
        const $element = $(element);
        const link = $element.find('.short-poster').attr('href');
        const title = $element.find('.short-title').text().trim();

        // Skip items that don't have "saison" in their title
        if (!title.toLowerCase().includes('saison')) {
          return;
        }

        const posterImg = $element.find('.short-poster img').attr('src');
        const poster = posterImg ? (posterImg.startsWith('/') ? `${FRENCHSTREAM_BASE_URL}${posterImg}` : posterImg) : null;
        const audioType = $element.find('.film-verz a').text().trim();

        // Extract episode count if available
        let episodeCount = null;
        const episodeElement = $element.find('.mli-eps i');
        if (episodeElement.length > 0) {
          episodeCount = parseInt(episodeElement.text().trim());
        }

        seriesList.push({
          title,
          link,
          poster,
          audio_type: audioType,
          episode_count: episodeCount,
          seasons: []  // Will be populated later for each series
        });
      } catch (error) {
        console.error(`Error parsing series element:`, error);
      }
    });

    return seriesList;
  } catch (error) {
    return { error: `Erreur lors de la recuperation des series: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// getFrenchStreamSeriesDetails
// ---------------------------------------------------------------------------
async function getFrenchStreamSeriesDetails(seriesUrl, originalTitle) {
  try {
    // Convertir les anciens domaines FrenchStream vers le domaine actif.
    // Les anciens domaines sont redirigés vers le domaine configuré (et non
    // plus vers un `frenchstream.food` figé).
    const targetUrl = seriesUrl
      .replace('fr.french-stream.sbs', FRENCHSTREAM_HOST)
      .replace('french-stream.gratis', FRENCHSTREAM_HOST)
      .replace('french-stream.legal', FRENCHSTREAM_HOST)
      .replace('french-stream.one', FRENCHSTREAM_HOST)
      .replace('frenchstream.food', FRENCHSTREAM_HOST);

    const response = await makeRequestWithCorsFallback(targetUrl, {
      timeout: 5000,
      decompress: true
    });

    const $ = cheerio.load(response.data);

    const seriesTitle = originalTitle;

    // Extract release date from <span class="release"> 2023 - </span>
    let releaseDate = null;

    // Essayer plusieurs selecteurs possibles pour la date de sortie
    const releaseSelectors = [
      'article div.fmain div.fleft div.poster span.release',
      'span.release',
      'article div.container div div span.release',
      'div.poster span.release',
      '.release'
    ];

    // Essayer chaque selecteur jusqu'a ce qu'on trouve la date
    for (const selector of releaseSelectors) {
      const releaseElement = $(selector);
      if (releaseElement.length > 0) {
        const releaseDateText = releaseElement.text().trim();
        // Extract year from text like "2023 - "
        const yearMatch = releaseDateText.match(/(\d{4})/);
        if (yearMatch) {
          releaseDate = yearMatch[1];
          break;
        }
      }
    }

    // Si toujours pas trouve, chercher dans toute la page
    if (!releaseDate) {
      // Chercher tout texte contenant 4 chiffres qui pourrait etre une annee
      const allText = $('body').text();
      const yearMatches = allText.match(/\b(19\d{2}|20\d{2})\b/g);
      if (yearMatches && yearMatches.length > 0) {
        // Prendre la premiere annee trouvee dans la page
        releaseDate = yearMatches[0];
      }
    }

    // Extract summary from <p> inside #s-desc element
    let summary = null;

    // Essayer differentes approches pour trouver le resume
    const summarySelectorApproaches = [
      // Approche 1: XPath complet converti en selecteur CSS
      () => {
        const summaryElement = $('body > div:nth-child(2) > div > div > article > div:nth-child(3) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > p:nth-child(2)');
        return summaryElement.length > 0 ? summaryElement.text().trim() : null;
      },

      // Approche 2: Recherche dans la zone principale du contenu
      () => {
        const mainContent = $('.finfo, .fcontent, .fdesc, #s-desc');
        if (mainContent.length > 0) {
          const paragraphs = mainContent.find('p');
          // Recuperer le paragraphe le plus long (probablement le resume)
          let longestText = "";
          paragraphs.each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > longestText.length &&
              !text.includes("Resume du film") &&
              !text.includes("streaming complet")) {
              longestText = text;
            }
          });
          return longestText.length > 100 ? longestText : null;
        }
        return null;
      },

      // Approche 3: Recherche par mots-cles
      () => {
        // Mots-cles qui indiquent probablement un resume
        const summaryKeywords = ["histoire", "serie", "saison", "episode", "personnage", "aventure"];
        const paragraphs = $('p');
        let bestMatch = null;
        let bestScore = 0;

        paragraphs.each((i, el) => {
          const text = $(el).text().trim();
          if (text.length < 100) return; // Trop court pour etre un resume

          // Calculer un score base sur les mots-cles presents
          let score = 0;
          const lowerText = text.toLowerCase();
          summaryKeywords.forEach(keyword => {
            if (lowerText.includes(keyword)) score++;
          });

          // Bonus pour la longueur (resumes typiquement plus longs)
          score += Math.min(text.length / 200, 3);

          // Malus pour les textes generiques
          if (text.includes("streaming") || text.includes("vostfr") ||
            text.includes("gratuit") || text.includes("Resume du film")) {
            score -= 5;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = text;
          }
        });

        return bestScore > 2 ? bestMatch : null;
      },

      // Approche 4: Recherche directe du texte apres les divs de metadonnees
      () => {
        // Trouver une div qui contient la date de sortie, puis chercher un paragraphe apres
        const releaseDiv = $('span.release').closest('div');
        if (releaseDiv.length > 0) {
          // Chercher le premier paragraphe substantiel apres cette div
          let currentElement = releaseDiv;
          let found = false;

          // Parcourir jusqu'a 10 elements suivants
          for (let i = 0; i < 10 && !found; i++) {
            currentElement = currentElement.next();
            if (currentElement.length === 0) break;

            // Si c'est un paragraphe, verifier son contenu
            if (currentElement.is('p')) {
              const text = currentElement.text().trim();
              if (text.length > 100 &&
                !text.includes("Resume du film") &&
                !text.includes("streaming complet")) {
                found = true;
                return text;
              }
            }

            // Si c'est une div, chercher des paragraphes a l'interieur
            const innerP = currentElement.find('p');
            if (innerP.length > 0) {
              const text = innerP.first().text().trim();
              if (text.length > 100 &&
                !text.includes("Resume du film") &&
                !text.includes("streaming complet")) {
                found = true;
                return text;
              }
            }
          }
        }
        return null;
      }
    ];

    // Essayer chaque approche jusqu'a trouver un resume
    for (const approach of summarySelectorApproaches) {
      try {
        const result = approach();
        if (result) {
          summary = result;
          break;
        }
      } catch (error) {
        console.error(`Erreur lors de l'extraction du resume: ${error.message}`);
      }
    }

    // Derniere tentative: analyse du HTML brut
    if (!summary) {
      try {
        const htmlContent = response.data;

        // Chercher le texte qui pourrait etre un resume apres des marqueurs communs
        const resumeMarkers = [
          '<div class="fdesc">',
          '<div id="s-desc">',
          '<h2>Synopsis</h2>',
          '<h3>Synopsis</h3>',
          'Synopsis :'
        ];

        for (const marker of resumeMarkers) {
          const markerIndex = htmlContent.indexOf(marker);
          if (markerIndex !== -1) {
            // Chercher le premier paragraphe substantiel apres ce marqueur
            const afterMarker = htmlContent.substring(markerIndex + marker.length);
            const paragraphMatch = afterMarker.match(/<p[^>]*>([^<]{100,})<\/p>/);

            if (paragraphMatch && paragraphMatch[1]) {
              summary = paragraphMatch[1].trim();
              break;
            }
          }
        }
      } catch (error) {
        console.error(`Erreur lors de l'analyse du HTML brut: ${error.message}`);
      }
    }

    // Valider que le resume n'est pas un texte par defaut
    if (summary && (
      summary.includes("Resume du film") ||
      summary.includes("streaming complet") ||
      summary.includes("vf et vostfr") ||
      summary.includes("vod gratuit sans limite")
    )) {
      summary = null;
    }

    // Find series on TMDB using the extracted info
    let tmdbData = null;
    if (seriesTitle) {
      // Pass the original title from FrenchStream; findTvSeriesOnTMDB will clean it
      tmdbData = await findTvSeriesOnTMDB(seriesTitle, releaseDate, summary);
    }

    // Find all seasons using the new structure
    const seasons = [];
    const seasonsContainer = $('.tab-content > .tab-pane'); // Updated selector

    seasonsContainer.each((seasonIndex, seasonElement) => {
      try {
        const $seasonElement = $(seasonElement);
        const seasonId = $seasonElement.attr('id'); // e.g., season-1
        const seasonNumberMatch = seasonId ? seasonId.match(/\d+$/) : null;
        const seasonNumber = seasonNumberMatch ? parseInt(seasonNumberMatch[0]) : seasonIndex + 1;
        const seasonTitle = `Saison ${seasonNumber}`;

        const episodesMap = new Map(); // Use a map to group by episode number

        // Find all episodes in this season
        const episodeElements = $seasonElement.find('ul li');

        episodeElements.each((episodeIndex, episodeElement) => {
          try {
            const $episodeElement = $(episodeElement);
            const episodeLink = $episodeElement.find('a').first();

            // Extract episode info
            const episodeNumStr = episodeLink.text().trim();
            const episodeNumMatch = episodeNumStr.match(/^\d+/);
            const episodeNum = episodeNumMatch ? episodeNumMatch[0] : episodeNumStr;

            const episodeTitle = episodeLink.attr('data-title') || `Episode ${episodeNumStr}`;
            const isVOSTFR = episodeTitle.includes('VOSTFR');
            const langKey = isVOSTFR ? 'vostfr' : 'vf';

            // Get player links
            const players = [];
            $episodeElement.find('.mirrors a').each((playerIndex, playerElement) => {
              const $playerElement = $(playerElement);
              const playerName = $playerElement.text().trim();
              const playerLink = $playerElement.attr('data-link');

              if (playerLink) {
                players.push({
                  name: playerName,
                  link: playerLink
                });
              }
            });

            // Get or create the entry for this episode number
            if (!episodesMap.has(episodeNum)) {
              episodesMap.set(episodeNum, {
                number: episodeNum,
                versions: {}
              });
            }

            // Add the current language version
            episodesMap.get(episodeNum).versions[langKey] = {
              title: episodeTitle,
              players: players
            };

          } catch (error) {
            console.error(`Error parsing episode element (Index ${episodeIndex}) in ${seriesUrl}:`, error.message);
          }
        });

        // Convert map values to array and sort numerically by episode number
        const episodes = Array.from(episodesMap.values()).sort((a, b) => {
          const numA = parseInt(a.number);
          const numB = parseInt(b.number);
          if (isNaN(numA) || isNaN(numB)) return a.number.localeCompare(b.number);
          return numA - numB;
        });

        seasons.push({
          number: seasonNumber,
          title: seasonTitle,
          episodes: episodes
        });
      } catch (error) {
        console.error(`Error parsing season element (ID ${seasonId || 'unknown'}) in ${seriesUrl}:`, error.message);
      }
    });

    return {
      title: seriesTitle,
      release_date: releaseDate,
      summary: summary,
      tmdb_data: tmdbData,
      seasons: seasons
    };
  } catch (error) {
    return { error: `Failed to fetch series details: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// extractSeriesInfo  -- helper to extract base name and part number
// ---------------------------------------------------------------------------
const extractSeriesInfo = (title) => {
  let baseName = title;
  let partNumber = 1; // Default to part 1
  let seasonInfo = {}; // Store season range if present

  // Match "Part X (Saison Y - Z)"
  const partMatch = title.match(/\s*Part\s+(\d+)\s*\(Saison\s+(\d+)\s*-\s*(\d+)\)/i);
  if (partMatch) {
    partNumber = parseInt(partMatch[1]);
    seasonInfo = {
      part: partNumber,
      start: parseInt(partMatch[2]),
      end: parseInt(partMatch[3])
    };
    // Remove the Part info from the base name
    baseName = baseName.replace(/\s*Part\s+\d+\s*\(Saison\s+\d+\s*-\s*\d+\)/i, '');
  }

  // Remove trailing "- Saison X"
  baseName = baseName.replace(/\s*-\s*Saison\s+\d+$/i, '');

  // Remove potential year in parenthesis if not already removed by part info
  baseName = baseName.replace(/\s*\(\d{4}\)/, '');

  return { baseName: baseName.trim(), partNumber, seasonInfo };
};

// ---------------------------------------------------------------------------
// mergeSeriesParts  -- merge multiple parts of a series
// ---------------------------------------------------------------------------
const mergeSeriesParts = (parts) => {
  if (!parts || parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return parts[0]; // Nothing to merge
  }

  // Sort parts by partNumber (extracted during grouping)
  parts.sort((a, b) => a.partNumber - b.partNumber);

  const mainPart = parts[0];
  const mergedSeasons = [...(mainPart.seasons || [])]; // Start with seasons from part 1

  // Track the maximum season number added so far
  let maxSeasonNumberSoFar = 0;
  if (mergedSeasons.length > 0) {
    maxSeasonNumberSoFar = Math.max(...mergedSeasons.map(s => s.number));
  }

  for (let i = 1; i < parts.length; i++) {
    const currentPart = parts[i];

    // Calculate the adjustment based on the max season number from the *previous* merged parts
    const adjustment = maxSeasonNumberSoFar;

    if (!currentPart.seasons || currentPart.seasons.length === 0) {
      console.log(`    Part ${currentPart.partNumber} has no seasons to merge.`);
      continue;
    }

    console.log(`    Adjusting ${currentPart.seasons.length} season(s) for Part ${currentPart.partNumber}.`);

    let partMaxSeason = 0; // Track max season added *in this part*
    currentPart.seasons.forEach(season => {
      const originalSeasonNumber = season.number;
      // The adjusted season number is the previous max + the original number from this part
      const adjustedSeasonNumber = adjustment + originalSeasonNumber;
      console.log(`      Merging Season ${originalSeasonNumber} -> ${adjustedSeasonNumber}`);

      // Create a new season object to avoid modifying the original
      const adjustedSeason = {
        ...season,
        number: adjustedSeasonNumber,
        // Adjust title like "Saison X"
        title: `Saison ${adjustedSeasonNumber}`
      };
      mergedSeasons.push(adjustedSeason);
      if (adjustedSeasonNumber > partMaxSeason) {
        partMaxSeason = adjustedSeasonNumber;
      }
    });
    // Update the overall max season number
    maxSeasonNumberSoFar = partMaxSeason;
  }

  // Return the main part with merged seasons
  // Ensure seasons are sorted correctly after merging
  mergedSeasons.sort((a, b) => a.number - b.number);

  return {
    ...mainPart, // Use metadata from the main part
    seasons: mergedSeasons
  };
};

// ---------------------------------------------------------------------------
// cleanTvCacheData  -- helper to clean TV cache data before sending
// ---------------------------------------------------------------------------
const cleanTvCacheData = (cachedData) => {
  if (!cachedData || !cachedData.series) {
    return cachedData; // Return as is if structure is unexpected
  }
  return {
    type: cachedData.type || 'tv', // ensure type is present
    series: (cachedData.series || []).map(s => ({
      title: s.title || s.baseName, // Use baseName if available
      audio_type: s.audio_type,
      episode_count: s.episode_count,
      release_date: s.release_date,
      summary: s.summary,
      tmdb_data: s.tmdb_data ? {
        id: s.tmdb_data.id,
        name: s.tmdb_data.name,
        overview: s.tmdb_data.overview,
        first_air_date: s.tmdb_data.first_air_date,
        poster_path: s.tmdb_data.poster_path,
        backdrop_path: s.tmdb_data.backdrop_path,
        vote_average: s.tmdb_data.vote_average,
        match_score: s.tmdb_data.match_score,
        is_season_part: s.tmdb_data.is_season_part, // Include season part info
        season_offset: s.tmdb_data.season_offset
      } : null,
      seasons: s.seasons || []
    }))
  };
};

// ---------------------------------------------------------------------------
// checkFrenchStreamVersion
// ---------------------------------------------------------------------------
async function checkFrenchStreamVersion(imdbId) {
  try {
    const url = `${FRENCHSTREAM_BASE_URL}/xfsearch/${imdbId}`;
    const response = await axiosFrenchStreamRequest({ method: 'get', url });
    const $ = cheerio.load(response.data);

    // Recherche de la version du film avec le XPath fourni
    const versionElement = $('*[id="dle-content"] div div span:nth-child(2) a');
    const version = versionElement.text().trim();

    return {
      version: version || 'Unknown',
      url: versionElement.attr('href') || null
    };
  } catch (error) {
    return { version: 'Unknown', url: null };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  configure,
  getFrenchStreamMovie,
  getFrenchStreamSeries,
  getFrenchStreamSeriesDetails,
  extractSeriesInfo,
  mergeSeriesParts,
  cleanTvCacheData,
  checkFrenchStreamVersion
};
