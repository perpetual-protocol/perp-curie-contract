import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.skip("ClearingHouse.swap gasEstimation", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })
        await pool.initialize(encodePriceSqrt("100", "1"))
        await clearingHouse.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseEther("1000000"))
        await deposit(alice, vault, 1000000, collateral)
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("10000"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseEther("1000000"))
        await deposit(carol, vault, 1000000, collateral)
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("10000"))
        await clearingHouse.connect(carol).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
        })
    })

    it("gas cost for maker", async () => {
        // carol long
        await collateral.mint(carol.address, parseEther("1000"))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("1000"))
        for (let i = 0; i < 720; i++) {
            await clearingHouse.connect(carol).swap({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
            })
            await forward(3600)
            await clearingHouse.updateFunding(baseToken.address)
        }

        // maker remove liquidity position
        const order = await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
        })

        // maker close position
        const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
        })
    }).timeout(300000) // 5 mins
})
