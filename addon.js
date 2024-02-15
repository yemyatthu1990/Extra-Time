const { addonBuilder } = require('stremio-addon-sdk');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');


const chrome = require('@sparticuz/chromium')
const puppeteer = require('puppeteer-core')

const leagues = require('./resources/leagues');
const jimp = require('jimp');

const endpoint = 'https://www.scorebat.com/video-api/v1/';
const genres = [
	'England',
	'Spain',
	'Germany',
	'Italy',
	'France',
	'Netherlands',
	'USA',
	'Argentina',
	'Brazil',
	'Mexico',
	'Europa League',
	'Other'
];

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
const manifest = {
	id: 'extra.time',
	version: '0.0.1',
	catalogs: [
		{
			type: 'sports',
			id: 'extraTimeCatalog',
			name: 'Football',
			extra: [{ name: 'genre', isRequired: false, options: genres }]
		}
	],
	resources: ['catalog', 'stream', 'meta'],
	types: ['sports'],
	name: 'Extra Time',
	description: 'Watch highlights and goals of the latest matches.',
	background:
		'https://images.pexels.com/photos/61143/pexels-photo-61143.jpeg?auto=compress&cs=tinysrgb&dpr=3&h=750&w=1260',
	logo:
		'https://creazilla-store.fra1.digitaloceanspaces.com/silhouettes/2488/female-soccer-player-silhouette-4bb7ee-md.png'
};
const builder = new addonBuilder(manifest);

let data = [];
let youtubeDict = {};
let backgrounds = {};

// Gets the data object from the server
if (!data.length) {
	axios
		.get(endpoint)
		.then(response => {
			data = response.data;
			return response.data;
		})
		.catch(error => {
			console.log(error);
			return [];
		});
}

/**
 * Removes space from one or more strings, usually titles, to create a predictable id
 *
 * @param {Array<string>} strings - An array of predictable strings to be sanitised
 * @return {string} A sanitised id
 */
const sanitiseId = strings => {
	return strings.map(string => string.replace(/\s/g, '')).join('|||');
};

/**
 * Returns the object from the data using id
 *
 * @param {string} id - A unique id that is used by stremio
 * @return {Object} The original object that correlates to the stremio id
 */
const getObject = id => {
	const objectArr = data.filter(obj => sanitiseId([obj.title]) === id);
	return objectArr.length ? objectArr[0] : null;
};

/**
 * Converts data array to catalog metas
 *
 * @param {Array<Object>} data - An array of original data objects
 * @return {Array<Object>} An array of stremio relevant meta objects
 */
const toMetas = async data => {
	const newData = await Promise.all(
		data.map(async object => {
			const meta = await toMeta(object);
			return meta;
		})
	);
	return newData;
};

/**
 * Converts single object to meta
 *
 * @param {Object} object - An original data object
 * @return {Object} A more in depth stremio meta object
 */
const toMeta = async (object, blur) => {
	const id = sanitiseId([object.title]);
	const league = object.competition
		? leagues[object.competition.name] || leagues.default
		: leagues.default;

	const genre =
		league === league.default
			? [formatString(object.competition.name), 'Other']
			: league.genres;

	let background = object.thumbnail;

	// toMeta is used in catalogue as well as for details page - we don't want to bother blurring everything
	// when it's loaded in catalogue as it would be too slow, therefore only blur if specified
	if (blur && !backgrounds[id]) {
		// Blurs the thumbnail to be used as the detail background - would be pixelated otherwise
		const image = await jimp.read(object.thumbnail);
		image.blur(5);

		// Get background image as base664 string
		background = await image.getBase64Async(jimp.MIME_PNG);
		backgrounds[id] = background;
	}

	const meta = {
		id,
		type: 'sports',
		name: object.title,
		poster: object.thumbnail,
		posterShape: 'landscape',
		background: background,
		logo: league.image,
		genre: genre,
		description: generateDescription(object),
		cast: [object.side1.name, object.side2.name],
		released: object.date,
		dvdRelease: object.date,
		country: /.+?(?=:)/.exec(formatString(object.competition.name))[0],
		website: object.url,
		isPeered: true,
		videos: object.videos.map(video => ({
			id: sanitiseId([object.title, video.title]),
			title: video.title,
			publishedAt: new Date(object.date),
			released: object.date,
			available: true
		}))
	};

	// If we're not blurring then resolve the promise immediately as we're not waiting for blur
	return blur ? meta : Promise.resolve(meta);
};

/**
 * Lower cases and then capitalises the ffirst letter of each word
 *
 * @param {string} string - The string to be formatted
 * @return {string} The formatted string
 */
const formatString = string => {
	const lowerCased = string.toLowerCase();
	const words = lowerCased.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1));
	return words.join(' ');
};

/**
 * Generates a description using the original data object
 *
 * @param {Object} object - An original data object
 * @return {string} The description made up of properties og the object
 */
const generateDescription = object => {
	const date = new Date(object.date);
	const dateString = date.toDateString();
	const timeString = date.toTimeString();
	return `Kick off on ${dateString} at ${timeString} between ${object.side1.name} and ${
		object.side2.name
	} for ${formatString(object.competition.name)}`;
};

/**
 * Parses the embed field of the object returning the stream url
 *
 * @param {string} embed - An embeddable string representing HTML
 * @return {string} The src pulled from an iframe in the embed
 */
const parseEmbed = embed => {
	const $ = cheerio.load(embed);
	return $('iframe').attr('src') || $('a').attr('href');
};

/**
 * Fetches the youtube id of the video by scraping it from the source code
 * a couple of iframe url levels deep and stores it in a dictionary against
 * the video id
 *
 * @param {Object} object - An original data object
 */
const fetchAndStoreVideos = object => {
	object.videos.forEach(async video => {
		// Return if youtube Id has already been found
		const videoId = sanitiseId([object.title, video.title]);
		if (youtubeDict[videoId]) return;

		// The youtube id is buried within a few urls so let's get the first one and read it's source
		const url1 = parseEmbed(video.embed);
		const source1 = await axios.get(url1);

		// Grab the next url
		const url2 = parseEmbed(source1.data);
		

		// This one requires javascript to load the data so use puppeteer to allow this to load
		puppeteer.launch({
			args: [...chrome.args, '--hide-scrollbars', '--disable-web-security'],
			defaultViewport: chrome.defaultViewport,
			executablePath: await chrome.executablePath,
			headless: true,
			ignoreHTTPSErrors: true,
		  })
			.then(browser => browser.newPage())
			.then(page => {
				return page.goto(url2).then(function() {
					return page.content();
				});
			})
			.then(html => {
				// Grab the youtube url from this page's html
				const url3 = parseEmbed(html);

				// It sometimes comes as an emdedded url and other times as the direct watch url
				let youtubeId = url3.includes('embed/')
					? url3.split('embed/')[1].split('?')[0]
					: url3.split('watch?v=')[1];

				// Cache the youtube id so we don't need to refetch it
				youtubeDict[videoId] = youtubeId;
			})
			.catch(console.error);
	});
};

/**
 * Waits a specified amount of time
 *
 * @param {number} ms - The time to wait in milliseconds
 * @return {Promise} The promise returned, resolevd after a certain amount of time
 */
const sleep = ms => {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
};

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/requests/defineCatalogHandler.md
builder.defineCatalogHandler(({ extra }) => {
	const resolve = async () => {
		let result = await toMetas(data);
		if (extra.genre === 'Other') {
			result = result.filter(meta => !meta.genre.some(genre => genres.includes(genre)));
		} else {
			result = extra.genre ? result.filter(meta => meta.genre.includes(extra.genre)) : result;
		}
		return Promise.resolve({ metas: result });
	};
	return resolve();
});

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/requests/defineMetaHandler.md
builder.defineMetaHandler(({ id }) => {
	const object = getObject(id);

	// Start fetching the youtube ids
	fetchAndStoreVideos(object);

	const resolve = async () => {
		const result = await toMeta(object, true);
		return Promise.resolve({ meta: result });
	};
	return resolve();
});

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/requests/defineStreamHandler.md
builder.defineStreamHandler(({ id }) => {
	const resolveWithYT = async () => {
		if (youtubeDict[id]) {
			// Resolve if youtube id has already been fetched
			return Promise.resolve({ streams: [{ ytId: youtubeDict[id] }] });
		} else {
			// Wait and retry to see if youtube id has now been fetched
			await sleep(100);
			return resolveWithYT();
		}
	};
	return resolveWithYT();
});

module.exports = builder.getInterface();
