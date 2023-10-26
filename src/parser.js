const fs = require('fs');
const luxon = require('luxon');
const xml2js = require('xml2js');

const shared = require('./shared');
const settings = require('./settings');
const translator = require('./translator');

async function parseFilePromise(config) {
	console.log('\nParsing...');
	const content = await fs.promises.readFile(config.input, 'utf8');
	const data = await xml2js.parseStringPromise(content, {
		trim: true,
		tagNameProcessors: [xml2js.processors.stripPrefix]
	});

	const postTypes = getPostTypes(data, config);
	const posts = await collectPosts(data, postTypes, config);

	const images = [];
	if (config.saveAttachedImages) {
		images.push(...collectAttachedImages(data));
	}
	if (config.saveScrapedImages) {
		images.push(...collectScrapedImages(data, postTypes));
	}

	mergeImagesIntoPosts(images, posts);

	return posts;
}

function getPostTypes(data, config) {
	if (config.includeOtherTypes) {
		// search export file for all post types minus some default types we don't want
		// effectively this will be 'post', 'page', and custom post types
		const types = data.rss.channel[0].item
			.map(item => item.post_type[0])
			.filter(type => !['attachment', 'revision', 'nav_menu_item', 'custom_css', 'customize_changeset'].includes(type));
		return [...new Set(types)]; // remove duplicates
	} else {
		// just plain old vanilla "post" posts
		return ['post'];
	}
}

function getItemsOfType(data, type) {
	return data.rss.channel[0].item.filter(item => item.post_type[0] === type);
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectPosts(data, postTypes, config) {
	// this is passed into getPostContent() for the markdown conversion
	const turndownService = translator.initTurndownService();

	let allPosts = [];
	for(const postType of postTypes) {
		const postsForType = getItemsOfType(data, postType)
			.filter(post => post.status[0] !== 'trash' && post.status[0] !== 'draft');
		const postsPromises = postsForType.map(async (post, index) => {
			// meta data isn't written to file, but is used to help with other things

			// Wait for a bit before processing this post if it's not the first one
			if (index !== 0) {
				await delay(5000); // delay of 1 second
			}

			let meta = {
				id: getPostId(post),
				slug: getPostSlug(post),
				coverImageId: getPostCoverImageId(post), 
				type: postType,
				imageUrls: [],
			}

			let frontmatter = {
				title: getPostTitle(post),
				date: getPostDate(post),
				categories: getCategories(post),
				tags: getTags(post),
				wp_id: getPostId(post),
				wp_type: postType,
				wp_slug: getPostSlug(post),
				creator: getPostCreator(post),
			}

			if(postType !== 'ai1ec_event') {
				return {
					meta,
					frontmatter,
					content: translator.getPostContent(post, turndownService, config)
				}
			} else {
				console.log(getPostId(post));
				const eventMetadata = await getEventMetadata(getPostId(post));
				if(!eventMetadata || !eventMetadata.event_data) {
					console.error("eventMetadata or eventMetadata.event_data is missing", getPostId(post), eventMetadata);
					return {
						meta,
						frontmatter,
						content: translator.getPostContent(post, turndownService, config)
					}
				}
				// otherwise enhance the frontmatter with event data
				frontmatter = {
					...frontmatter,
					start_datetime: eventMetadata.event_data.start_datetime,
					end_datetime: eventMetadata.event_data.end_datetime,
					venue: eventMetadata.event_data.venue,
					address: getAddress(eventMetadata),
					ical_source_url: eventMetadata.event_data.ical_source_url,
				}
				return {
					meta,
					frontmatter,
					content: translator.getPostContent(post, turndownService, config)
				}
			}
		});
			
		if (postTypes.length > 1) {
			console.log(`${postsForType.length} "${postType}" posts found.`);
		}

		const resolvedPostsForType = await Promise.all(postsPromises);
		allPosts.push(...resolvedPostsForType.filter(Boolean)); // filter undefined Posts
	}

	if (postTypes.length === 1) {
		console.log(allPosts.length + ' posts found.');
	}
	console.log("finished collecting posts");
	return allPosts;
}

function getPostId(post) {
	return post.post_id[0];
}

function getPostSlug(post) {
	return decodeURIComponent(post.post_name[0]);
}

function getPostCoverImageId(post) {
	if (post.postmeta === undefined) {
		return undefined;
	}

	const postmeta = post.postmeta.find(postmeta => postmeta.meta_key[0] === '_thumbnail_id');
	const id = postmeta ? postmeta.meta_value[0] : undefined;
	return id;
}

function getPostTitle(post) {
	return post.title[0];
}

function getPostDate(post) {
	const dateTime = luxon.DateTime.fromRFC2822(post.pubDate[0], { zone: 'utc' });

	if (settings.custom_date_formatting) {
		return dateTime.toFormat(settings.custom_date_formatting);
	} else if (settings.include_time_with_date) {
		return dateTime.toISO();
	} else {
		return dateTime.toISODate();
	}
}

function getCategories(post) {
	const categories = processCategoryTags(post, 'category');
	return categories.filter(category => !settings.filter_categories.includes(category));
}

function getTags(post) {
	return processCategoryTags(post, 'post_tag');
}

function processCategoryTags(post, domain) {
	if (!post.category) {
		return [];
	}

	return post.category
		.filter(category => category.$.domain === domain)
		.map(({ $: attributes }) => decodeURIComponent(attributes.nicename));
}

function collectAttachedImages(data) {
	const images = getItemsOfType(data, 'attachment')
		// filter to certain image file types
		.filter(attachment => (/\.(gif|jpe?g|png)$/i).test(attachment.attachment_url[0]))
		.map(attachment => ({
			id: attachment.post_id[0],
			postId: attachment.post_parent[0],
			url: attachment.attachment_url[0]
		}));

	console.log(images.length + ' attached images found.');
	return images;
}

function collectScrapedImages(data, postTypes) {
	const images = [];
	postTypes.forEach(postType => {
		getItemsOfType(data, postType).forEach(post => {
			const postId = post.post_id[0];
			const postContent = post.encoded[0];
			const postLink = post.link[0];

			const matches = [...postContent.matchAll(/<img[^>]*src="(.+?\.(?:gif|jpe?g|png))"[^>]*>/gi)];
			matches.forEach(match => {
				// base the matched image URL relative to the post URL
				const url = new URL(match[1], postLink).href;
				images.push({
					id: -1,
					postId: postId,
					url
				});
			});
		});
	});

	console.log(images.length + ' images scraped from post body content.');
	return images;
}

function mergeImagesIntoPosts(images, posts) {
	images.forEach(image => {
		posts.forEach(post => {
			let shouldAttach = false;

			// this image was uploaded as an attachment to this post
			if (image.postId === post.meta.id) {
				shouldAttach = true;
			}

			// this image was set as the featured image for this post
			if (image.id === post.meta.coverImageId) {
				shouldAttach = true;
				post.frontmatter.coverImage = shared.getFilenameFromUrl(image.url);
			}

			if (shouldAttach && !post.meta.imageUrls.includes(image.url)) {
				post.meta.imageUrls.push(image.url);
			}
		});
	});
}

function getEventMetadata(id) {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);

		fetch(`https://dssg.fas.harvard.edu/wp-json/wp/v2/events/${id}`, {
				signal: controller.signal
			})
			.then(res => {
				clearTimeout(timeout);
				if (!res.ok) {
					console.error(`HTTP error! status: ${res.status}`);
					return;
				}
				return res.json();
			})
			.then(data => {
				resolve(data);
			})
			.catch(err => {
				console.error(`Error fetching metadata for post ${id}:`, err);
				reject(err);
			});
	});
}

function getAddress(eventMetadata){
	let province = eventMetadata.event_data.province;
	let city = eventMetadata.event_data.city;
	let address = eventMetadata.event_data.address;
	let postal_code = eventMetadata.event_data.postal_code;
	return `${address}, ${city}, ${province}, ${postal_code}`
}

function getPostCreator(post){
	return post.creator[0];
}

exports.parseFilePromise = parseFilePromise;
