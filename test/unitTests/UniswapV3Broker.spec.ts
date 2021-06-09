import { TestUniswapV3Broker } from "../../typechain"
import { expect } from "chai"
import { testUniswapV3BrokerFixture } from "../shared/fixturesUT"
import { waffle } from "hardhat"

describe("UniswapV3Broker UT", () => {
    const SMALL_ADDRESS = "0x1e5433845880780B10e6570f2EEdB0826709C4Ae"
    const LARGE_ADDRESS = "0xD16a6772163463C731e37Ef42c98EEe95f15A496"

    let testUniswapV3Broker: TestUniswapV3Broker

    before(async () => {
        const _testUniswapV3BrokerFixture = await waffle.loadFixture(testUniswapV3BrokerFixture)
        testUniswapV3Broker = _testUniswapV3BrokerFixture.testUniswapV3Broker
    })

    it("#getTokenOrder: should not re-ordered the returning value", async () => {
        const [token0, token1] = await testUniswapV3Broker.getTokenOrder(SMALL_ADDRESS, LARGE_ADDRESS)
        expect(token0).to.eq(SMALL_ADDRESS)
        expect(token1).to.eq(LARGE_ADDRESS)
    })

    it("#getTokenOrder: should re-ordered the returning value", async () => {
        const [token0, token1] = await testUniswapV3Broker.getTokenOrder(LARGE_ADDRESS, SMALL_ADDRESS)
        expect(token0).to.eq(SMALL_ADDRESS)
        expect(token1).to.eq(LARGE_ADDRESS)
    })
})
