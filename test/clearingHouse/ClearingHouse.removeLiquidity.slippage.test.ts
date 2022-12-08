import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumberish } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, OrderBook, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity slippage", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        // mint
        collateral.mint(admin.address, parseEther("10000"))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)
    })

    describe("# removeLiquidity failed at tick 50199", () => {
        let liquidity: BigNumberish
        beforeEach(async () => {
            const initPrice = "151.373306858723226651"
            await initMarket(fixture, initPrice)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("1", await baseToken.decimals()),
                quote: 0,
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
            const order = await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            liquidity = order.liquidity
        })

        it("force error, over slippage protection when removing liquidity above price with only base", async () => {
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50200,
                    upperTick: 50400,
                    liquidity,
                    minBase: parseUnits("101"),
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSCF")
        })

        it("force error, over deadline", async () => {
            const now = (await waffle.provider.getBlock("latest")).timestamp
            await clearingHouse.setBlockTimestamp(now + 1)

            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50200,
                    upperTick: 50400,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: now,
                }),
            ).to.revertedWith("CH_TE")
        })
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# removeLiquidity failed at tick 50200", () => {
        let liquidity: BigNumberish
        beforeEach(async () => {
            const initPrice = "151.373306858723226652"
            await initMarket(fixture, initPrice)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: 0,
                quote: parseUnits("9999.999999", await baseToken.decimals()),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
            const order = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
            liquidity = order.liquidity
        })

        it("force error, over slippage protection when removing liquidity below price with only quote token", async () => {
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50200,
                    liquidity,
                    minBase: 0,
                    minQuote: parseUnits("10001"),
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSCF")
        })
    })
})
