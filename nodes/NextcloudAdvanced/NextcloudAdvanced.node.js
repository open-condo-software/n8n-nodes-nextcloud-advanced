'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Parse a WebDAV PROPFIND XML response and return a flat list of file entries.
 * @param {string} xml
 * @param {string} webDavUrl  - base WebDAV URL (used to strip the path prefix)
 * @returns {{ nodeId: string, path: string, displayName: string, isDirectory: boolean, contentType: string, size: number, lastModified: string }[]}
 */
function parseWebDavXml(xml, webDavUrl) {
	const results = [];
	const responseBlocks = xml.match(/<[Dd]:response[\s\S]*?<\/[Dd]:response>/g) || [];

	const davBasePath = new URL(webDavUrl).pathname.replace(/\/$/, '');

	for (const block of responseBlocks) {
		const hrefMatch = block.match(/<[Dd]:href>([\s\S]*?)<\/[Dd]:href>/);
		if (!hrefMatch) continue;

		const rawHref = hrefMatch[1].trim();
		let filePath = decodeURIComponent(rawHref);
		if (filePath.startsWith(davBasePath)) {
			filePath = filePath.slice(davBasePath.length);
		}
		filePath = filePath.replace(/\/$/, '') || '/';

		const isDirectory = /<[Dd]:collection\s*\/>/.test(block);

		const fileIdMatch = block.match(/<oc:fileid>([\s\S]*?)<\/oc:fileid>/i);
		const nodeId = fileIdMatch ? fileIdMatch[1].trim() : '';

		const displayNameMatch = block.match(/<[Dd]:displayname>([\s\S]*?)<\/[Dd]:displayname>/i);
		const displayName = displayNameMatch ? displayNameMatch[1].trim() : filePath.split('/').pop() || '';

		const contentTypeMatch = block.match(/<[Dd]:getcontenttype>([\s\S]*?)<\/[Dd]:getcontenttype>/i);
		const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : (isDirectory ? 'httpd/unix-directory' : '');

		const sizeMatch = block.match(/<[Dd]:getcontentlength>([\s\S]*?)<\/[Dd]:getcontentlength>/i);
		const size = sizeMatch ? parseInt(sizeMatch[1].trim(), 10) : 0;

		const lastModMatch = block.match(/<[Dd]:getlastmodified>([\s\S]*?)<\/[Dd]:getlastmodified>/i);
		const lastModified = lastModMatch ? lastModMatch[1].trim() : '';

		results.push({ nodeId, path: filePath, displayName, isDirectory, contentType, size, lastModified });
	}

	return results;
}

/**
 * Perform a WebDAV PROPFIND request and return the response body as a string.
 * @param {string} webDavUrl
 * @param {string} path
 * @param {string} user
 * @param {string} password
 * @param {number} depth  0 | 1 | 'infinity'
 * @returns {Promise<string>}
 */
function propfind(webDavUrl, path, user, password, depth) {
	return new Promise((resolve, reject) => {
		const base = new URL(webDavUrl);
		const encodedPath = path === '/'
			? ''
			: path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
		const requestPath = base.pathname.replace(/\/$/, '') + encodedPath;

		const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <D:getcontenttype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <oc:fileid/>
  </D:prop>
</D:propfind>`;

		const auth = Buffer.from(`${user}:${password}`).toString('base64');

		const options = {
			hostname: base.hostname,
			port: base.port || (base.protocol === 'https:' ? 443 : 80),
			path: requestPath,
			method: 'PROPFIND',
			headers: {
				'Authorization': `Basic ${auth}`,
				'Depth': String(depth),
				'Content-Type': 'application/xml; charset=utf-8',
				'Content-Length': Buffer.byteLength(body),
			},
		};

		const transport = base.protocol === 'https:' ? https : http;
		const req = transport.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					resolve(data);
				} else if (res.statusCode === 207) {
					resolve(data);
				} else {
					reject(new Error(`WebDAV PROPFIND failed: HTTP ${res.statusCode} for path "${requestPath}"`));
				}
			});
		});

		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

/**
 * Recursively list all files under a given path using Depth:1 per directory
 * (avoids server-side 'infinity' depth restrictions common on Nextcloud).
 * @param {string} webDavUrl
 * @param {string} startPath
 * @param {string} user
 * @param {string} password
 * @returns {Promise<object[]>}
 */
async function listFilesRecursive(webDavUrl, startPath, user, password) {
	const allFiles = [];
	const queue = [startPath];

	while (queue.length > 0) {
		const currentPath = queue.shift();
		const xml = await propfind(webDavUrl, currentPath, user, password, 1);
		const entries = parseWebDavXml(xml, webDavUrl);

		for (const entry of entries) {
			if (entry.path === currentPath || entry.path === currentPath.replace(/\/$/, '')) {
				continue;
			}
			allFiles.push(entry);
			if (entry.isDirectory) {
				queue.push(entry.path);
			}
		}
	}

	return allFiles;
}

class NextcloudAdvanced {
	constructor() {
		this.description = {
			displayName: 'Nextcloud Advanced',
			name: 'nextcloudAdvanced',
			icon: 'file:nextcloud.svg',
			group: ['transform'],
			version: 1,
			subtitle: '={{$parameter["operation"]}}',
			description: 'Advanced Nextcloud operations such as recursive file listing',
			defaults: {
				name: 'Nextcloud Advanced',
			},
			inputs: ['main'],
			outputs: ['main'],
			credentials: [
				{
					name: 'nextCloudApi',
					required: true,
				},
			],
			properties: [
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					options: [
						{
							name: 'List Files',
							value: 'listFiles',
							description: 'Recursively list all files and folders under a path',
							action: 'List files recursively',
						},
					],
					default: 'listFiles',
				},
				{
					displayName: 'Folder Path',
					name: 'folderPath',
					type: 'string',
					default: '/',
					placeholder: '/Public Files',
					description: 'Folder to scan. Use "/" for the root, or a path like "/Public Files" for a team folder. Leave blank for root.',
					displayOptions: {
						show: {
							operation: ['listFiles'],
						},
					},
				},
				{
					displayName: 'Return Directories',
					name: 'returnDirectories',
					type: 'boolean',
					default: false,
					description: 'Whether to include directory entries in the results (files only by default)',
					displayOptions: {
						show: {
							operation: ['listFiles'],
						},
					},
				},
				{
					displayName: 'Execution Mode',
					name: 'executionMode',
					type: 'options',
					noDataExpression: true,
					options: [
						{
							name: 'Run Once',
							value: 'runOnce',
							description: 'Execute once regardless of input items',
						},
						{
							name: 'Run for Each Item',
							value: 'forEachItem',
							description: 'Execute once per input item (default)',
						},
					],
					default: 'forEachItem',
					description: 'Whether to run the operation once or for each incoming item',
					displayOptions: {
						show: {
							operation: ['listFiles'],
						},
					},
				},
			],
		};
	}

	async execute() {
		const items = this.getInputData();
		const returnData = [];

		const credentials = await this.getCredentials('nextCloudApi');
		const webDavUrl = credentials.webDavUrl;
		const user = credentials.user;
		const password = credentials.password;

		const operation = this.getNodeParameter('operation', 0);
		const executionMode = this.getNodeParameter('executionMode', 0, 'forEachItem');

		if (executionMode === 'runOnce') {
			// Run once using the first item's parameters only
			if (operation === 'listFiles') {
				let folderPath = this.getNodeParameter('folderPath', 0, '/');
				const returnDirectories = this.getNodeParameter('returnDirectories', 0, false);

				if (!folderPath || folderPath.trim() === '') {
					folderPath = '/';
				}
				if (!folderPath.startsWith('/')) {
					folderPath = '/' + folderPath;
				}

				const files = await listFilesRecursive(webDavUrl, folderPath, user, password);

				for (const file of files) {
					if (!returnDirectories && file.isDirectory) continue;
					returnData.push({
						json: {
							nodeId: file.nodeId,
							path: file.path,
							displayName: file.displayName,
							isDirectory: file.isDirectory,
							contentType: file.contentType,
							size: file.size,
							lastModified: file.lastModified,
						},
						pairedItem: { item: 0 },
					});
				}
			}
		} else {
			// Default behavior: run for each input item
			for (let i = 0; i < items.length; i++) {
				if (operation === 'listFiles') {
					let folderPath = this.getNodeParameter('folderPath', i, '/');
					const returnDirectories = this.getNodeParameter('returnDirectories', i, false);

					if (!folderPath || folderPath.trim() === '') {
						folderPath = '/';
					}
					if (!folderPath.startsWith('/')) {
						folderPath = '/' + folderPath;
					}

					const files = await listFilesRecursive(webDavUrl, folderPath, user, password);

					for (const file of files) {
						if (!returnDirectories && file.isDirectory) continue;
						returnData.push({
							json: {
								nodeId: file.nodeId,
								path: file.path,
								displayName: file.displayName,
								isDirectory: file.isDirectory,
								contentType: file.contentType,
								size: file.size,
								lastModified: file.lastModified,
							},
							pairedItem: { item: i },
						});
					}
				}
			}
		}

		return [returnData];
	}
}

module.exports = { NextcloudAdvanced };
