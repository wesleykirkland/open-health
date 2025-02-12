/* eslint-disable */
import * as fsPromise from "node:fs/promises";
import fs from 'node:fs';
import {fromBuffer as pdf2picFromBuffer} from 'pdf2pic'
import {ChatPromptTemplate} from "@langchain/core/prompts";
import {HealthCheckupSchema, HealthCheckupType} from "@/lib/health-data/parser/schema";
import FormData from "form-data";
import fetch from "node-fetch";
import {fileTypeFromBuffer} from 'file-type';
import {getFileMd5, processBatchWithConcurrency, resolveUploadPath} from "@/lib/health-data/parser/util";
import {getParsePrompt, MessagePayload} from "@/lib/health-data/parser/prompt";
import visions from "@/lib/health-data/parser/vision";

interface VisionParserOptions {
    parser: string;
    model: string;
    apiKey: string;
}

interface SourceParseOptions {
    file: string;
    visionParser?: VisionParserOptions
    ocr?: 'upstage' | 'docling'
}

interface InferenceOptions {
    imagePaths: string[],
    excludeImage: boolean,
    excludeText: boolean,
    visionParser: VisionParserOptions
}

async function documentOCR({document}: { document: string }) {
    const documentFile = await fsPromise.readFile(document)
    const filename = await getFileMd5(documentFile)
    const path = `./public/uploads/${filename}_ocr.json`

    // if file exists, return the result
    const fileExists = await fsPromise.access(path).then(() => true).catch(() => false)
    if (fileExists) return JSON.parse(await fsPromise.readFile(path, 'utf-8'))

    const formData = new FormData();
    formData.append('document', fs.createReadStream(document));
    formData.append("schema", "oac");
    formData.append("model", "ocr-2.2.1");

    const response = await fetch('https://api.upstage.ai/v1/document-ai/ocr', {
        method: 'POST',
        body: formData,
        headers: {Authorization: `Bearer ${process.env.UPSTAGE_API_KEY}`}
    });

    const result = await response.json()

    // Save the result
    await fsPromise.writeFile(path, JSON.stringify(result))

    return result
}

async function documentParse({document}: { document: string }) {
    const documentFile = await fsPromise.readFile(document)
    const filename = await getFileMd5(documentFile)
    const path = `./public/uploads/${filename}.json`

    // if file exists, return the result
    const fileExists = await fsPromise.access(path).then(() => true).catch(() => false)
    if (fileExists) return JSON.parse(await fsPromise.readFile(path, 'utf-8'))

    const formData = new FormData();
    formData.append('document', fs.createReadStream(document));
    formData.append('ocr', 'force')
    formData.append('output_formats', JSON.stringify(["markdown"]))
    formData.append("coordinates", "true");
    formData.append("model", "document-parse");

    const response = await fetch('https://api.upstage.ai/v1/document-ai/document-parse', {
        method: 'POST',
        body: formData,
        headers: {Authorization: `Bearer ${process.env.UPSTAGE_API_KEY}`}
    })

    const result = await response.json()

    // Save the result
    await fsPromise.writeFile(path, JSON.stringify(result))

    return result
}

async function inference(inferenceOptions: InferenceOptions) {
    const {imagePaths, excludeImage, excludeText, visionParser: visionParserOptions} = inferenceOptions

    // Extract text data if not excluding text
    const pageDataList: { page_content: string }[] | undefined = !excludeText ? await processBatchWithConcurrency(
        imagePaths,
        async (path) => {
            const {content} = await documentParse({document: path})
            const {markdown} = content
            return {page_content: markdown}
        },
        2
    ) : undefined

    // Extract image data if not excluding images
    const imageDataList: string[] = !excludeImage ? await processBatchWithConcurrency(
        imagePaths,
        async (path) => `data:image/png;base64,${(await fsPromise.readFile(path)).toString('base64')}`,
        4
    ) : []

    // Batch Inputs
    const numPages = pageDataList ? pageDataList.length : imageDataList.length
    const batchInputs: MessagePayload[] = new Array(numPages).fill(0).map((_, i) => ({
        ...(!excludeText && pageDataList ? {context: pageDataList[i].page_content} : {}),
        ...(!excludeImage && imageDataList ? {image_data: imageDataList[i]} : {})
    }))

    // Generate Messages
    const messages = ChatPromptTemplate.fromMessages(getParsePrompt({excludeImage, excludeText}));

    // Select Vision Parser
    const visionParser = visions.find(e => e.name === visionParserOptions.parser)
    if (!visionParser) throw new Error('Invalid vision parser')

    // Get models
    const visionParserModels = await visionParser.models()
    const visionParserModel = visionParserModels.find(e => e.id === visionParserOptions.model)
    if (!visionParserModel) throw new Error('Invalid vision parser model')

    // Process the batch inputs
    const batchData = await processBatchWithConcurrency(
        batchInputs,
        async (input) => visionParser.parse({
            model: visionParserModel,
            messages: messages,
            input: input,
            apiKey: visionParserOptions.apiKey
        }),
        4
    )

    // Merge the results
    const data: { [key: string]: HealthCheckupType } = batchData.reduce((acc, curr, i) => {
        acc[`page_${i}`] = curr;
        return acc;
    }, {} as { [key: string]: HealthCheckupType });

    // Merge Results
    const mergeInfo: { [key: string]: { pages: number[], values: any[] } } = {}

    for (const key of HealthCheckupSchema.shape.test_result.keyof().options) {
        const testFields = [];
        const testPages: number[] = [];
        for (let i = 0; i < numPages; i++) {
            const healthCheckup = data[`page_${i}`]
            const healthCheckupTestResult = healthCheckup.test_result

            if (healthCheckupTestResult.hasOwnProperty(key) && healthCheckupTestResult[key]) {
                testFields.push(healthCheckupTestResult[key])
                testPages.push(i)
            }
        }

        if (testFields.length > 0) {
            mergeInfo[key] = {'pages': testPages, 'values': testFields}
        }
    }

    const mergedTestResult: { [key: string]: any } = {}
    const mergedTestResultPage: { [key: string]: { page: number } } = {}

    // Merge the results
    for (const mergeInfoKey in mergeInfo) {
        const mergeTarget = mergeInfo[mergeInfoKey]
        mergedTestResult[mergeInfoKey] = mergeTarget.values[0]
        mergedTestResultPage[mergeInfoKey] = {
            page: mergeTarget.pages[0] + 1
        }
    }

    let mergeData: any = {}

    // Merge name and date
    for (let i = 0; i < numPages; i++) {
        const healthCheckup = data[`page_${i}`]
        mergeData = {
            ...mergeData,
            ...healthCheckup,
        }
    }

    // Update test_result with merged data
    mergeData['test_result'] = mergedTestResult

    // Create final HealthCheckup object
    const finalHealthCheckup = HealthCheckupSchema.parse(mergeData)

    return {
        finalHealthCheckup: finalHealthCheckup,
        mergedTestResultPage: mergedTestResultPage,
    }
}

/**
 * Convert a document to images
 * - pdf: convert to images
 * - image: nothing
 *
 * @param file
 *
 * @returns {Promise<string[]>} - List of image paths
 */
async function documentToImages({file: filePath}: Pick<SourceParseOptions, 'file'>): Promise<string[]> {
    const file = await fsPromise.readFile(filePath)
    const fileBuffer = Buffer.from(file)
    const result = await fileTypeFromBuffer(fileBuffer)
    const fileHash = await getFileMd5(fileBuffer)
    if (!result) throw new Error('Invalid file type')
    const mime = result.mime

    // Convert pdf to images, or use the image as is
    const images: string[] = []
    if (mime === 'application/pdf') {
        const pdf2picConverter = pdf2picFromBuffer(fileBuffer, {preserveAspectRatio: true})
        for (const image of await pdf2picConverter.bulk(-1, {responseType: 'base64'})) {
            if (image.base64) images.push(`data:image/png;base64,${image.base64}`)
        }
    } else {
        images.push(`data:${mime};base64,${fileBuffer.toString('base64')}`)
    }

    // Write the image data to a file
    const imagePaths = []
    for (let i = 0; i < images.length; i++) {
        const path = await resolveUploadPath(`${fileHash}_${i}.png`)
        await fsPromise.writeFile(path, Buffer.from(images[i].split(',')[1], 'base64'))
        imagePaths.push(path)
    }

    return imagePaths
}

/**
 * Parse the health data
 *
 * @param options
 */
export async function parseHealthData(options: SourceParseOptions) {
    const {file: filePath} = options

    // prepare images
    const imagePaths = await documentToImages({file: filePath})

    // prepare ocr results
    const ocrResults = await documentOCR({document: filePath})

    // prepare parse results
    await processBatchWithConcurrency(
        imagePaths,
        async (path) => documentParse({document: path}),
        3
    )

    // VisionParser
    const visionParser = options.visionParser || {
        parser: 'OpenAI',
        model: 'gpt-4o',
        apiKey: process.env.OPENAI_API as string
    }

    // Merge the results
    const baseInferenceOptions = {imagePaths, visionParser}
    const [
        {finalHealthCheckup: resultTotal, mergedTestResultPage: resultTotalPages},
        {finalHealthCheckup: resultText, mergedTestResultPage: resultTextPages},
        {finalHealthCheckup: resultImage, mergedTestResultPage: resultImagePages}
    ] = await Promise.all([
        inference({...baseInferenceOptions, excludeImage: false, excludeText: false}),
        inference({...baseInferenceOptions, excludeImage: false, excludeText: true}),
        inference({...baseInferenceOptions, excludeImage: true, excludeText: false}),
    ]);

    const resultDictTotal = resultTotal.test_result
    const resultDictText = resultText.test_result
    const resultDictImage = resultImage.test_result

    const mergedTestResult: { [key: string]: any } = {}
    const mergedPageResult: { [key: string]: { page: number } | null } = {}

    for (const key of HealthCheckupSchema.shape.test_result.keyof().options) {
        const valueTotal =
            resultDictTotal.hasOwnProperty(key) &&
            resultDictTotal[key] !== null &&
            resultDictTotal[key]!.value !== null
                ? resultDictTotal[key]
                : null;
        const pageTotal = valueTotal !== null ? resultTotalPages[key] : null;

        const valueText =
            resultDictText.hasOwnProperty(key) &&
            resultDictText[key] !== null &&
            resultDictText[key]!.value !== null
                ? resultDictText[key]
                : null;
        const pageText = valueText !== null ? resultTextPages[key] : null;

        const valueImage =
            resultDictImage.hasOwnProperty(key) &&
            resultDictImage[key] !== null &&
            resultDictImage[key]!.value !== null
                ? resultDictImage[key]
                : null;
        const pageImage = valueImage !== null ? resultImagePages[key] : null;

        if (valueTotal === null) {
            if (valueText !== null) {
                mergedTestResult[key] = valueText;
                mergedPageResult[key] = pageText;
            } else if (valueImage !== null) {
                mergedTestResult[key] = valueImage;
                mergedPageResult[key] = pageImage;
            } else {
                mergedTestResult[key] = valueText;
                mergedPageResult[key] = pageText;
            }
        } else {
            mergedTestResult[key] = valueTotal;
            mergedPageResult[key] = pageTotal;
        }
    }

    // remove all null values in mergedTestResult
    for (const key in mergedTestResult) {
        if (mergedTestResult[key] === null) {
            delete mergedTestResult[key]
        }
    }

    const healthCheckup = HealthCheckupSchema.parse({
        ...resultTotal,
        test_result: mergedTestResult
    })

    return {data: [healthCheckup], pages: [mergedPageResult], ocrResults: [ocrResults]}
}
