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
	const posts = collectPosts(data, postTypes, config);

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

function collectPosts(data, postTypes, config) {
	// this is passed into getPostContent() for the markdown conversion
	const turndownService = translator.initTurndownService();

	let allPosts = [];
	// Load the extra post data from the export file ../../events.json
	const eventsData = require('../../events.json');
	// console.log(eventsData);

	postTypes.forEach(postType => {
		const postsForType = getItemsOfType(data, postType)
			.filter(post => post.status[0] !== 'trash' && post.status[0] !== 'draft')
			.map(post => {
			// meta data isn't written to file, but is used to help with other things
			// console.log(getPostId(post));
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
			};
			if (postType === 'ai1ec_event') {
				// the event data is a json blob with keys of the post id
				let eventData = eventsData[meta.id];
				if (eventData) {
					enrichedFrontmatter = {
						...frontmatter,
						start_datetime: eventData.event_data.start_datetime,
						end_datetime: eventData.event_data.end_datetime,
						venue: eventData.event_data.venue,
						address: getAddress(eventData),
						ical_source_url: eventData.event_data.ical_source_url
					}
					frontmatter = enrichedFrontmatter;
				}
			}

			return {
				meta: meta,
				frontmatter: frontmatter,
				content: translator.getPostContent(post, turndownService, config)
			}
		});

		if (postTypes.length > 1) {
			console.log(`${postsForType.length} "${postType}" posts found.`);
		}

		allPosts.push(...postsForType);
	});

	if (postTypes.length === 1) {
		console.log(allPosts.length + ' posts found.');
	}
	function validatePost(post) {
		if(!post.frontmatter.date) {
			throw new Error(`Post missing date: ${JSON.stringify(post)}`)
		}
	}
	  
	// let invalidPosts = [];
	// allPosts.forEach(post => {
	//   try {
	// 	validatePost(post);
	//   } catch(err) {
	// 	invalidPosts.push(post);
	//   }
	// })
	// console.log("Invalid posts:", invalidPosts);

	console.log("TEST POSTS ===========");
	console.log(allPosts[0]);

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
	// console.log("Images:", images);

	// function validateImage(image) {
	// 	if(!image.id) console.log(`Image missing id: ${JSON.stringify(image)}`);
	// }

	// function validatePost(post){
	// 	if(!post.meta) console.log(`Post missing id: ${JSON.stringify(post)}`);
	// }
	
	// images.forEach(validateImage);
	// posts.forEach(validatePost);

	images.forEach(image => {
		posts.forEach(post => {
			let shouldAttach = false;

			// this image was uploaded as an attachment to this post
			if(post.meta && post.meta.id && image.postId && image.postId === post.meta.id){ // check for existence
				shouldAttach = true;
			}

			// this image was set as the featured image for this post
			if (image.id && post.meta && post.meta.coverImageId && image.id === post.meta.coverImageId) {
				shouldAttach = true;
				post.frontmatter.coverImage = shared.getFilenameFromUrl(image.url);
			}

			if (shouldAttach && !post.meta.imageUrls.includes(image.url)) {
				post.meta.imageUrls.push(image.url);
			}
		});
	});
}

function getAddress(eventMetadata){
	let province = eventMetadata.event_data.province;
	let city = eventMetadata.event_data.city;
	let address = eventMetadata.event_data.address;
	let postal_code = eventMetadata.event_data.postal_code;

	let addressComponents = [address, city, province, postal_code];
	let validComponents = addressComponents.filter(component => component && component.trim() !== '');

	return validComponents.join(', ');
}

function getPostCreator(post){
	return post.creator[0];
}

exports.parseFilePromise = parseFilePromise;