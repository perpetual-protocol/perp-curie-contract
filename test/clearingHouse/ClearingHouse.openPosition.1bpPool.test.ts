import { MockContract } from "@eth-optimism/smock"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { token0Fixture } from "../shared/fixtures"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

async function deployNewMarket(fixture: ClearingHouseFixture, uniFeeTier: number) {
    const uniV3Factory = fixture.uniV3Factory
    const quoteToken = fixture.quoteToken
    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")

    const _token0Fixture = await token0Fixture(fixture.quoteToken.address)
    const baseToken = _token0Fixture.baseToken
    const mockedPriceFeedDispatcher = _token0Fixture.mockedPriceFeedDispatcher
    await uniV3Factory.createPool(baseToken.address, quoteToken.address, uniFeeTier)
    const poolAddr = await uniV3Factory.getPool(baseToken.address, quoteToken.address, uniFeeTier)
    const pool = poolFactory.attach(poolAddr) as UniswapV3Pool

    await baseToken.addWhitelist(pool.address)
    await baseToken.addWhitelist(fixture.clearingHouse.address)
    await quoteToken.addWhitelist(pool.address)
    await baseToken.mintMaximumTo(fixture.clearingHouse.address)

    return { baseToken, pool, mockedPriceFeedDispatcher }
}

describe("ClearingHouse.openPosition.1bpPool gasEstimation", () => {
    const [admin, maker, maker2, maker3, maker4, maker5, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let baseToken3: BaseToken
    let baseToken4: BaseToken
    let baseToken5: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let mockedPriceFeedDispatcher2: MockContract
    let mockedPriceFeedDispatcher3: MockContract
    let mockedPriceFeedDispatcher4: MockContract
    let mockedPriceFeedDispatcher5: MockContract
    let collateralDecimals: number
    let oneBpPool: UniswapV3Pool
    let minTick: number
    let maxTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(true, 3000))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance as TestAccountBalance
        clearingHouseConfig = fixture.clearingHouseConfig
        vault = fixture.vault
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        mockedPriceFeedDispatcher2 = fixture.mockedPriceFeedDispatcher2
        ;({ baseToken: baseToken3, mockedPriceFeedDispatcher: mockedPriceFeedDispatcher3 } = await deployNewMarket(
            fixture,
            3000,
        ))
        ;({ baseToken: baseToken4, mockedPriceFeedDispatcher: mockedPriceFeedDispatcher4 } = await deployNewMarket(
            fixture,
            100,
        ))
        ;({
            baseToken: baseToken5,
            mockedPriceFeedDispatcher: mockedPriceFeedDispatcher5,
            pool: oneBpPool,
        } = await deployNewMarket(fixture, 100))

        collateralDecimals = await collateral.decimals()

        const initPrice = "151.373306858723226652"
        ;({ minTick, maxTick } = await initMarket(fixture, initPrice))
        await mockIndexPrice(mockedPriceFeedDispatcher, "151")

        await initMarket(fixture, initPrice, undefined, undefined, undefined, baseToken2.address)
        await mockIndexPrice(mockedPriceFeedDispatcher2, "151")

        await initMarket(fixture, initPrice, undefined, undefined, undefined, baseToken3.address)
        await mockIndexPrice(mockedPriceFeedDispatcher3, "151")

        await initMarket(fixture, initPrice, undefined, undefined, undefined, baseToken4.address, 100)
        await mockIndexPrice(mockedPriceFeedDispatcher4, "151")

        // baseToken5 is a 1bp pool
        await initMarket(fixture, "1", undefined, undefined, undefined, baseToken5.address, 100)
        await mockIndexPrice(mockedPriceFeedDispatcher5, "1")

        // maker add v2 style liquidity in pools
        await collateral.mint(maker.address, parseUnits("10000000", collateralDecimals))
        await deposit(maker, vault, 10000000, collateral)
        await addOrder(fixture, maker, 1000, 150000, minTick, maxTick)
        await addOrder(fixture, maker, 1000, 150000, minTick, maxTick, false, baseToken2.address)
        await addOrder(fixture, maker, 1000, 150000, minTick, maxTick, false, baseToken3.address)
        await addOrder(fixture, maker, 1000, 150000, minTick, maxTick, false, baseToken4.address)
        await addOrder(fixture, maker, 100000, 100000, -1000, 1000, false, baseToken5.address)

        // maker2 ~ maker5 add multiple liquidity in pool base5
        await collateral.mint(maker2.address, parseUnits("1000000", collateralDecimals))
        await deposit(maker2, vault, 1000000, collateral)
        await collateral.mint(maker3.address, parseUnits("1000000", collateralDecimals))
        await deposit(maker3, vault, 1000000, collateral)
        await collateral.mint(maker4.address, parseUnits("1000000", collateralDecimals))
        await deposit(maker4, vault, 1000000, collateral)
        await collateral.mint(maker5.address, parseUnits("1000000", collateralDecimals))
        await deposit(maker5, vault, 1000000, collateral)

        // mint collateral for taker
        await collateral.mint(taker.address, parseUnits("1000000", collateralDecimals))
        await deposit(taker, vault, 1000000, collateral)

        // taker add order in 3 market
        await addOrder(fixture, maker, 10, 1500, minTick, maxTick)
        await addOrder(fixture, maker, 10, 1500, minTick, maxTick, false, baseToken2.address)
        await addOrder(fixture, maker, 10, 1500, minTick, maxTick, false, baseToken3.address)

        // taker open position in other 4 pools
        await q2bExactInput(fixture, taker, 100)
        await q2bExactInput(fixture, taker, 100, baseToken2.address)
        await q2bExactInput(fixture, taker, 100, baseToken3.address)
        await q2bExactInput(fixture, taker, 100, baseToken4.address)
    })

    it("gas cost with only 1 liquidity", async () => {
        // open position in 1bp pool
        const receipt = await (await q2bExactInput(fixture, taker, 5000, baseToken5.address)).wait()
        console.log("gas used: ", receipt.gasUsed.toString())

        const tick = (await oneBpPool.slot0()).tick
        console.log("current tick: ", tick)
    })

    it("gas cost with 10 liquidity", async () => {
        await addOrder(fixture, maker2, 100, 100, -1, 1, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -2, 2, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -3, 3, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -4, 4, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -5, 5, false, baseToken5.address)

        await addOrder(fixture, maker3, 100, 100, -6, 6, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -7, 7, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -8, 8, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -9, 9, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -10, 10, false, baseToken5.address)

        // open position in 1bp pool
        const receipt = await (await q2bExactInput(fixture, taker, 5000, baseToken5.address)).wait()
        console.log("gas used: ", receipt.gasUsed.toString())

        const tick = (await oneBpPool.slot0()).tick
        console.log("current tick: ", tick)
    })

    it("gas cost with 20 liquidity", async () => {
        await addOrder(fixture, maker2, 100, 100, -1, 1, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -2, 2, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -3, 3, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -4, 4, false, baseToken5.address)
        await addOrder(fixture, maker2, 100, 100, -5, 5, false, baseToken5.address)

        await addOrder(fixture, maker3, 100, 100, -6, 6, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -7, 7, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -8, 8, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -9, 9, false, baseToken5.address)
        await addOrder(fixture, maker3, 100, 100, -10, 10, false, baseToken5.address)

        await addOrder(fixture, maker4, 100, 100, -11, 11, false, baseToken5.address)
        await addOrder(fixture, maker4, 100, 100, -12, 12, false, baseToken5.address)
        await addOrder(fixture, maker4, 100, 100, -13, 13, false, baseToken5.address)
        await addOrder(fixture, maker4, 100, 100, -14, 14, false, baseToken5.address)
        await addOrder(fixture, maker4, 100, 100, -15, 15, false, baseToken5.address)

        await addOrder(fixture, maker5, 100, 100, -16, 16, false, baseToken5.address)
        await addOrder(fixture, maker5, 100, 100, -17, 17, false, baseToken5.address)
        await addOrder(fixture, maker5, 100, 100, -18, 18, false, baseToken5.address)
        await addOrder(fixture, maker5, 100, 100, -19, 19, false, baseToken5.address)
        await addOrder(fixture, maker5, 100, 100, -20, 20, false, baseToken5.address)

        // open position in 1bp pool
        const receipt = await (await q2bExactInput(fixture, taker, 5000, baseToken5.address)).wait()
        console.log("gas used: ", receipt.gasUsed.toString())

        const tick = (await oneBpPool.slot0()).tick
        console.log("current tick: ", tick)
    })
})
