import { CallExpression, CodeBlockWriter, Node, SourceFile, SyntaxKind, VariableDeclarationKind } from 'ts-morph'
import { getStringHash, getStringLiteralOrText, writeValueFromObjectLiteralElement } from './utils.js'

interface ProcedureUnit {
	tag: 'procedure'
	type: string
	pathText: string
	options?: Node
	middlewares: MiddlewareUnit[]
	middlewaresHash?: string
}

interface RouterUnit {
	tag: 'router'
	prefix: string
	identifier: string
}

interface MiddlewareUnit {
	tag: 'middleware'
	id: string
	hash: number
	body: string
}

type Unit = ProcedureUnit | RouterUnit | MiddlewareUnit

const handleRouterPropertyAccessor = (
	options: { node: Node; arguments: Node[]; middlewares: MiddlewareUnit[] },
): Unit => {
	const { node, arguments: arguments_, middlewares } = options

	const propertyAccessorText = node.getText()
	if (propertyAccessorText === 'merge') {
		const [prefix, router] = arguments_
		return {
			tag: 'router',
			prefix: getStringLiteralOrText(prefix),
			identifier: router.getText(),
		}
	}

	if (propertyAccessorText === 'middleware') {
		const [function_] = arguments_
		const middlewareBody = function_.getText()
		const hash = getStringHash(middlewareBody)
		return {
			tag: 'middleware',
			id: `middleware_${hash}`,
			hash,
			body: middlewareBody,
		}
	}

	const [path, optionsNode] = arguments_
	return {
		tag: 'procedure',
		type: node.getText(),
		pathText: getStringLiteralOrText(path),
		options: optionsNode,
		middlewares,
		middlewaresHash: middlewares.length > 0 ? middlewares.map((v) => v.id).join(',') : undefined,
	}
}

interface GetRouterProceduresOptions {
	node: CallExpression
	units?: Unit[]
	middlewares?: MiddlewareUnit[]
}

export const getRouterProcedures = (
	options: GetRouterProceduresOptions,
): { units: Unit[]; topNode: Node } => {
	const { node, units = [], middlewares = [] } = options

	const propertyAccessParent = node.getParentIfKind(SyntaxKind.PropertyAccessExpression)

	if (!propertyAccessParent) return { units, topNode: node }
	const propertyAccessor = propertyAccessParent.getChildAtIndex(2)

	const callExpressionParent = propertyAccessParent.getParentIfKind(SyntaxKind.CallExpression)
	if (!callExpressionParent) return { units, topNode: propertyAccessParent }

	const unit = handleRouterPropertyAccessor({
		node: propertyAccessor,
		arguments: callExpressionParent.getArguments(),
		middlewares,
	})
	units.push(unit)

	const newMiddlewares = unit.tag === 'middleware' ? [...middlewares, unit] : middlewares

	return getRouterProcedures({ node: callExpressionParent, units, middlewares: newMiddlewares })
}

export const writeNewRouter = (
	options: { units: Unit[]; sourceFile: SourceFile; topNode: Node },
) => {
	const { units, sourceFile, topNode } = options

	const procedureUnits = units.filter((unit): unit is ProcedureUnit => unit.tag === 'procedure')
	const routerUnits = units.filter((unit): unit is RouterUnit => unit.tag === 'router')

	const procedureMiddlewareHashes = procedureUnits
		.map((unit) => unit.middlewares)
		.filter((unit) => unit.length > 0)
	const uniqueMiddlewareCombinations = new Set(procedureMiddlewareHashes)

	const middlewaresProcedureIdMap = new Map<MiddlewareUnit[], string>()
	for (const middlewares of uniqueMiddlewareCombinations.values()) {
		const middlewaresHash = middlewares.map((middleware) => middleware.hash).join('_')
		middlewaresProcedureIdMap.set(middlewares, `procedure_${middlewaresHash}`)
	}

	type ProcedureOrRouterRecord = Record<string, ProcedureUnit | RouterShape>
	interface RouterShape extends Pick<RouterUnit, 'tag' | 'prefix'> {
		units: ProcedureOrRouterRecord
		text?: string
	}

	const routerShape: RouterShape = {
		tag: 'router',
		units: {},
		prefix: '',
	}
	const addProcedure = (shape: RouterShape, procedureUnit: ProcedureUnit, pathParts: string[], index = 0) => {
		if (pathParts.length - 1 === index) {
			shape.units[pathParts[index]] = procedureUnit
			return
		}
		const router: RouterShape = {
			tag: 'router',
			prefix: pathParts[index],
			units: {},
		}
		shape.units[pathParts[index]] = router
		addProcedure(router, procedureUnit, pathParts, index + 1)
	}

	const addRouter = (shape: RouterShape, routerUnit: RouterUnit, pathParts: string[], index = 0) => {
		if (pathParts.length - 1 === index) {
			shape.units[pathParts[index]] = {
				tag: 'router',
				prefix: pathParts[index],
				text: routerUnit.identifier,
				units: {},
			}
			return
		}
		const router: RouterShape = {
			tag: 'router',
			prefix: pathParts[index],
			units: {},
		}
		shape.units[pathParts[index]] = router

		addRouter(router, routerUnit, pathParts, index + 1)
	}

	for (const unit of procedureUnits) {
		const pathParts = unit.pathText.split('.')
		addProcedure(routerShape, unit, pathParts)
	}

	for (const unit of routerUnits) {
		const pathParts = unit.prefix.split('.').filter((value) => value !== '')
		addRouter(routerShape, unit, pathParts)
	}

	const writeProcedure = (writer: CodeBlockWriter, unit: ProcedureUnit) => {
		const { type, options, middlewares } = unit

		const procedureHash = middlewaresProcedureIdMap.get(middlewares) ?? 't.procedure'

		writer.write(procedureHash)
		if (Node.isObjectLiteralExpression(options)) {
			for (const procedureOption of ['input', 'output', 'meta']) {
				const property = options?.getProperty(procedureOption)
				if (!property) continue

				writer.write(`.${procedureOption}(`)
				writeValueFromObjectLiteralElement(writer, property)
				writer.write(`)`)
			}

			const resolver = options?.getProperty('resolve')
			if (resolver) {
				writer.write(`.${type}(`)
				writeValueFromObjectLiteralElement(writer, resolver)
				writer.write(')')
			}
		} else {
			writer.write(`.${type}(${options?.getText() ?? ''})`)
		}
		return
	}

	const writeShape = (writer: CodeBlockWriter, procedureOrShape: RouterShape | ProcedureUnit, path?: string) => {
		if (path) {
			writer.write(path).write(': ')
		}

		if (procedureOrShape.tag === 'router') {
			if ('text' in procedureOrShape) {
				const { text } = procedureOrShape
				writer.write(`${text},`)
				return
			}

			writer.write(`t.router(`).inlineBlock(() => {
				for (const [path, nestedShape] of Object.entries(procedureOrShape.units)) {
					writeShape(writer, nestedShape, path)
				}
			}).write(')')
		} else {
			writeProcedure(writer, procedureOrShape)
		}

		if (path) {
			writer.write(',')
		}

		writer.newLine()
	}

	topNode.replaceWithText((writer) => {
		writeShape(writer, routerShape)
	})

	const middlewareUnits = units.filter((unit): unit is MiddlewareUnit => unit.tag === 'middleware')

	const ancestors = topNode.getAncestors()
	const topLevelNode = ancestors[ancestors.length - 2]

	for (const unit of middlewareUnits) {
		sourceFile.insertVariableStatement(topLevelNode.getChildIndex(), {
			declarationKind: VariableDeclarationKind.Const,
			declarations: [{
				name: unit.id,
				initializer: `t.middleware(${unit.body})`,
			}],
		}).formatText()
	}

	for (const [middlewares, procedureId] of middlewaresProcedureIdMap.entries()) {
		const middlewareUses: string[] = []
		for (const middleware of middlewares) {
			middlewareUses.push(`.use(${middleware.id})`)
		}
		sourceFile.insertVariableStatement(topLevelNode.getChildIndex(), {
			declarationKind: VariableDeclarationKind.Const,
			declarations: [{
				name: procedureId,
				initializer: `t.procedure${middlewareUses.join('')}`,
			}],
		})
	}
}
