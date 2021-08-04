import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { formatEther, formatUnits, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.skip("ClearingHouse maker close position", () => {
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
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })
        await pool.initialize(encodePriceSqrt("10", "1"))
        await clearingHouse.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("500"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("50"))
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("50"),
            quote: parseEther("500"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("500"))
        await clearingHouse.connect(carol).mint(baseToken.address, parseEther("50"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("50"),
            quote: parseEther("500"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    it("bob long, maker close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("250"))
        await clearingHouse.connect(bob).swap({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true, // exact input (quote)
            amount: parseEther("250"),
            sqrtPriceLimitX96: 0,
        })

        // maker remove liquidity position
        const order = await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
        console.log(`posSize=${formatEther(posSize.toString())}`)

        {
            const pnl = await clearingHouse.getOwedRealizedPnl(alice.address)
            const freeCollateral = await vault.getFreeCollateral(alice.address)
            console.log(`pnl=${formatEther(pnl.toString())}`)
            console.log(`freeCollateral=${formatUnits(freeCollateral.toString(), 6)}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`quote: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`baseToken: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }

        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: false, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
        })

        {
            const pnl = await clearingHouse.getOwedRealizedPnl(alice.address)
            const freeCollateral = await vault.getFreeCollateral(alice.address)
            console.log(`pnl=${formatEther(pnl.toString())}`)
            console.log(`freeCollateral=${formatUnits(freeCollateral.toString(), 6)}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`quote: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`baseToken: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }
    })

    it("bob short, maker close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).mint(baseToken.address, parseEther("25"))
        await clearingHouse.connect(bob).swap({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            amount: parseEther("25"),
            sqrtPriceLimitX96: 0,
        })

        // maker remove liquidity position
        const order = await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
        console.log(`posSize=${formatEther(posSize.toString())}`)

        {
            const pnl = await clearingHouse.getOwedRealizedPnl(alice.address)
            const freeCollateral = await vault.getFreeCollateral(alice.address)
            console.log(`pnl=${formatEther(pnl.toString())}`)
            console.log(`freeCollateral=${formatUnits(freeCollateral.toString(), 6)}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`quote: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`baseToken: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }

        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true, // quote to base
            isExactInput: true, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
        })

        {
            const pnl = await clearingHouse.getOwedRealizedPnl(alice.address)
            const freeCollateral = await vault.getFreeCollateral(alice.address)
            console.log(`pnl=${formatEther(pnl.toString())}`)
            console.log(`freeCollateral=${formatUnits(freeCollateral.toString(), 6)}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`quote: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }
        {
            const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            const avai = tokenInfo.available
            const debt = tokenInfo.debt
            console.log(`baseToken: avai=${formatEther(avai.toString())}, debt=${formatEther(debt.toString())}`)
        }
    })
})
