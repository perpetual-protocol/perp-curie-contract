pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IExchange.sol";
import "../../../contracts/interface/IClearingHouse.sol";
import "../../../contracts/BaseToken.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";

contract ClearingHouseTest is Setup {
    uint256 traderPrivateKey = uint256(1);
    uint256 makerPrivateKey = uint256(2);
    address trader = vm.addr(traderPrivateKey);
    address maker = vm.addr(makerPrivateKey);

    uint8 usdcDecimals;

    function setUp() public virtual override {
        Setup.setUp();

        vm.label(trader, "Trader");
        vm.label(maker, "Maker");

        // initial market
        pool.initialize(792281625142 ether);
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 100000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // mock priceFeed oracle
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

        // mint usdc to trader and deposit to vault
        uint256 traderUsdcAmount = 1000 * 10**usdcDecimals;
        usdc.mint(trader, traderUsdcAmount);
        vm.startPrank(trader);
        usdc.approve(address(vault), traderUsdcAmount);
        vault.deposit(address(usdc), traderUsdcAmount);
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

        // initiate timestamp to enable last tick update; should be larger than Exchange._TICK_SNAPSHOT_INTERVAL
        vm.warp(block.timestamp + 100);

        // mock price oracle
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

        vm.stopPrank();

        int256 positionSize = accountBalance.getTakerPositionSize(address(trader), address(baseToken));
        assertEq(positionSize, -1 ether);
    }
}
