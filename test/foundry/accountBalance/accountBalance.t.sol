pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IIndexPrice.sol";
import { IUniswapV3PoolState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";

contract AccountBalanceTest is Setup {
    function setUp() public virtual override {
        Setup.setUp();
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
    }

    function test_getMarkPrice_should_return_index_twap_if_marketRegistry_not_set() public {
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        // mock index twap
        uint256 indexTwap = 100;
        vm.mockCall(
            address(baseToken),
            abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, indexTwapInterval),
            abi.encode(indexTwap)
        );
        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);
    }

    function test_getMarkPrice_should_return_moving_average_price_if_marketRegistry_is_set() public {
        accountBalance.setMarketRegistry(address(marketRegistry));

        // mock current market price
        uint160 sqrtPrice = 100 ether;
        uint160 sqrtPriceX96 = sqrtPrice.mul(FixedPoint96.Q96);
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(0, 0, 0, 0, 0, 0, false)
        );

        // mock market twap
        // mock moving average
    }
}
