import formatterTest from './Formatter.test'
import modelsTest from './Models.test'
import mockServiceTest from './MockService.test'
import markdownParserTest from './MarkdownParser.test'
import storeTest from './Store.test'

export default function testsuite() {
  formatterTest()
  modelsTest()
  mockServiceTest()
  markdownParserTest()
  storeTest()
}
