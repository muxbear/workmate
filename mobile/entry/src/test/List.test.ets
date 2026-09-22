import formatterTest from './Formatter.test'
import modelsTest from './Models.test'
import mockServiceTest from './MockService.test'
import markdownParserTest from './MarkdownParser.test'
import markdownArtifactsTest from './MarkdownArtifacts.test'
import artifactGroupsTest from './ArtifactGroups.test'
import markdownBlocksTest from './MarkdownBlocks.test'
import sseParserTest from './SseParser.test'
import storeTest from './Store.test'

export default function testsuite() {
  formatterTest()
  modelsTest()
  mockServiceTest()
  markdownParserTest()
  markdownArtifactsTest()
  artifactGroupsTest()
  markdownBlocksTest()
  sseParserTest()
  storeTest()
}
