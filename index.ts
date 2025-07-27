#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import fetch from "node-fetch"
import { JSDOM } from "jsdom"
import { Readability } from "@mozilla/readability"
import TurndownService from "turndown"
import pdfparse from "pdf-parse"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Image {
	src: string
	alt: string
}

interface ExtractedContent {
	markdown: string
	images: Image[]
}

const DEFAULT_USER_AGENT_AUTONOMOUS =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"

const FetchArgsSchema = z.object({
	url: z.string().url(),
	maxLength: z.number().positive().max(1000000).default(20000),
	startIndex: z.number().min(0).default(0),
	raw: z.boolean().default(false),
})

const ListToolsSchema = z.object({
	method: z.literal("tools/list"),
})

const CallToolSchema = z.object({
	method: z.literal("tools/call"),
	params: z.object({
		name: z.string(),
		arguments: z.record(z.unknown()).optional(),
	}),
})

function extractContentFromHtml(
	html: string,
	url: string,
): ExtractedContent | string {
	const dom = new JSDOM(html, { url })
	const reader = new Readability(dom.window.document)
	const article = reader.parse()

	if (!article || !article.content) {
		return "<e>Page failed to be simplified from HTML</e>"
	}

	// Extract images from the article content only
	const articleDom = new JSDOM(article.content)
	const imgElements = Array.from(
		articleDom.window.document.querySelectorAll("img"),
	)

	const images: Image[] = imgElements.map((img) => {
		const src = img.src
		const alt = img.alt || ""
		return { src, alt }
	})

	const turndownService = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	})
	const markdown = turndownService.turndown(article.content)

	return { markdown, images }
}

async function commandExists(cmd: string): Promise<boolean> {
	try {
		await execAsync(`which ${cmd}`)
		return true
	} catch {
		return false
	}
}

interface FetchResult {
	content: string
	prefix: string
	imageUrls?: string[]
}

async function fetchUrl(
	url: string,
	userAgent: string,
	forceRaw = false,
): Promise<FetchResult> {
	const response = await fetch(url, {
		headers: { "User-Agent": userAgent },
	})

	if (!response.ok) {
		throw new Error(`Failed to fetch ${url} - status code ${response.status}`)
	}

	const contentType = response.headers.get("content-type") || ""
	const text = await response.text()
	const isHtml =
		text.toLowerCase().includes("<html") || contentType.includes("text/html")
  const isPdf = contentType.includes("application/pdf")

	if (isHtml && !forceRaw) {
		const result = extractContentFromHtml(text, url)
		if (typeof result === "string") {
			return {
				content: result,
				prefix: "",
			}
		}

		const { markdown, images } = result
		const imageUrls = images.map((img) => img.src).slice(0, 10) // Limit to first 10 images

		return {
			content: markdown,
			prefix: "",
			imageUrls,
		}
	}

  if (isPdf && !forceRaw) {
    let bytes = Buffer.from(await response.arrayBuffer())
    const text = (await pdfparse(bytes))?.text || ""
    return {
      content: text,
      prefix: "",
      imageUrls: [],
    }
  }

	return {
		content: text,
		prefix: `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n`,
	}
}

// Server setup
const server = new Server(
	{
		name: "mcp-fetch2",
		version: "10.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
)

interface RequestHandlerExtra {
	signal: AbortSignal
}

server.setRequestHandler(
	ListToolsSchema,
	async (request: { method: "tools/list" }, extra: RequestHandlerExtra) => {
		const tools = [
			{
				name: "fetch",
				description:
					"Retrieves URLs from the Internet and extracts their content as markdown. If images are found, their URLs will be included in the response.",
				inputSchema: zodToJsonSchema(FetchArgsSchema),
			},
		]
		return { tools }
	},
)

server.setRequestHandler(
	CallToolSchema,
	async (
		request: {
			method: "tools/call"
			params: { name: string; arguments?: Record<string, unknown> }
		},
		extra: RequestHandlerExtra,
	) => {
		try {
			const { name, arguments: args } = request.params

			if (name !== "fetch") {
				throw new Error(`Unknown tool: ${name}`)
			}

			const parsed = FetchArgsSchema.safeParse(args)
			if (!parsed.success) {
				throw new Error(`Invalid arguments: ${parsed.error}`)
			}

			const { content, prefix, imageUrls } = await fetchUrl(
				parsed.data.url,
				DEFAULT_USER_AGENT_AUTONOMOUS,
				parsed.data.raw,
			)

			let finalContent = content
			if (finalContent.length > parsed.data.maxLength) {
				finalContent = finalContent.slice(
					parsed.data.startIndex,
					parsed.data.startIndex + parsed.data.maxLength,
				)
				finalContent += `\n\n<e>Content truncated. Call the fetch tool with a start_index of ${
					parsed.data.startIndex + parsed.data.maxLength
				} to get more content.</e>`
			}

			let imagesSection = ""
			if (imageUrls && imageUrls.length > 0) {
				imagesSection =
					"\n\nImages found in page:\n" +
					imageUrls.map((url) => `- ${url}`).join("\n")
			}

			return {
				content: [
					{
						type: "text",
						text: `${prefix}Contents of ${parsed.data.url}:\n${finalContent}${imagesSection}`,
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Error: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			}
		}
	},
)

// Parse CLI arguments
function parseArgs(): { mode: 'stdio' | 'http' } {
	const args = process.argv.slice(2)
	let mode: 'stdio' | 'http' = 'stdio' // default to stdio
	
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--mode' && i + 1 < args.length) {
			const modeValue = args[i + 1]
			if (modeValue === 'stdio' || modeValue === 'http') {
				mode = modeValue
			} else {
				process.stderr.write(`Invalid mode: ${modeValue}. Valid options are: stdio, http\n`)
				process.exit(1)
			}
		}
	}
	
	return { mode }
}

async function runServerStdio() {
	const transport = new StdioServerTransport()
	await server.connect(transport)
}

async function runServerHTTP() {
	// TODO: Implement HTTP server functionality
	throw new Error('HTTP server mode not implemented yet')
}

async function main() {
	const { mode } = parseArgs()
	
	if (mode === 'stdio') {
		await runServerStdio()
	} else if (mode === 'http') {
		await runServerHTTP()
	}
}

main().catch((error) => {
	process.stderr.write(`Fatal error running server: ${error}\n`)
	process.exit(1)
})
