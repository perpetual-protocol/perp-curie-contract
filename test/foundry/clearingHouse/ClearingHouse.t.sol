pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import { IClearingHouse } from "../../../contracts/interface/IClearingHouse.sol";
import { BaseToken } from "../../../contracts/BaseToken.sol";
import { IPriceFeedDispatcher } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeedDispatcher.sol";

contract ClearingHouseTest is Setup {
    address trader = makeAddr("Trader");
    address maker = makeAddr("Maker");

    uint8 usdcDecimals;
    uint8 priceFeedDecimals;

    function setUp() public virtual override {
        Setup.setUp();

        // initial market
        pool.initialize(792281625142 ether);
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 100000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // wait for 30 mins after market is deployed
        skip(1800);

        priceFeedDecimals = IPriceFeedDispatcher(_BASE_TOKEN_PRICE_FEED).decimals();

        // mock priceFeed oracle
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(100 * (10**priceFeedDecimals))
        );
        usdcDecimals = usdc.decimals();

        // mint usdc to maker and deposit to vault
        uint256 makerUsdcAmount = 10000 * 10**usdcDecimals;
        usdc.mint(maker, makerUsdcAmount);
        vm.startPrank(maker);
        usdc.approve(address(vault), makerUsdcAmount);
        vault.deposit(address(usdc), makerUsdcAmount);
        vm.stopPrank();

        // mint usdc to trader and deposit to vault
        uint256 traderUsdcAmount = 1000 * 10**usdcDecimals;
        usdc.mint(trader, traderUsdcAmount);
        vm.startPrank(trader);
        usdc.approve(address(vault), traderUsdcAmount);
        vault.deposit(address(usdc), traderUsdcAmount);
        vm.stopPrank();

        // maker add liquidity
        vm.prank(maker);
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

        // initiate timestamp to enable last tick update; should be larger than Exchange._PRICE_LIMIT_INTERVAL
        vm.warp(block.timestamp + 100);
    }

    function test_open_position_example() external {
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: true,
                amount: 1 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp + 1000,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        int256 positionSize = accountBalance.getTakerPositionSize(address(trader), address(baseToken));
        assertEq(positionSize, -1 ether);
    }
}
